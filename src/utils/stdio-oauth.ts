import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';
import {
	chmod, mkdir, readFile, rename, rm, writeFile,
} from 'node:fs/promises';
import {
	createServer, type IncomingMessage, type Server, type ServerResponse,
} from 'node:http';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';
import {CodeChallengeMethod, gaxios, type OAuth2Client} from 'google-auth-library';
import {z} from 'zod';

export type StdioOAuthConfig = {
	client: OAuth2Client;
	callbackPort: number;
	scopes: string[];
	credentialsPath: string;
	openBrowser: (url: string) => Promise<void>;
};

const credentialSchema = z.object({refreshToken: z.string().min(1)}).strict();
const callbackSchema = z.object({state: z.string().min(1), code: z.string().min(1).optional(), error: z.string().min(1).optional()});
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const log = (category: string) => {
	console.error(`gmail-mcp: ${category}`);
};

export function getStdioCredentialsPath(clientId: string, scopes: string[]): string {
	const key = createHash('sha256').update(JSON.stringify([clientId, [...scopes].sort()])).digest('hex');
	return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'gmail-mcp', 'oauth', `${key}.json`);
}

function hasErrorCode(error: unknown, code: string): boolean {
	return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function isRevoked(error: unknown): boolean {
	if (!(error instanceof gaxios.GaxiosError)) {
		return false;
	}

	const data: unknown = error.response?.data;
	const parsed = z.object({error: z.string()}).safeParse(data);
	return parsed.success && parsed.data.error === 'invalid_grant';
}

function respond(response: ServerResponse, status: number, message: string, finished?: () => void): void {
	if (status >= 400) {
		log(message);
	}

	response.writeHead(status, {'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store'});
	response.end(message, finished);
}

export class StdioOAuth {
	private ready = false;
	private closed = false;
	private starting?: Promise<void>;
	private reauthorizing: Promise<void> | undefined;
	private server: Server | undefined;
	private timer: NodeJS.Timeout | undefined;
	private cancel: (() => void) | undefined;
	private saving?: Promise<void>;
	private stopping?: Promise<void>;
	private closingServer: Server | undefined;
	private readonly abort = new AbortController();
	private failure: Error | undefined;
	private exchanging?: Promise<void>;

	constructor(private readonly config: StdioOAuthConfig) {
		config.client.transporter.defaults.signal = this.abort.signal;
	}

	async start(): Promise<void> {
		if (this.closed) {
			return Promise.reject(new Error('Gmail authorization is closed.'));
		}

		this.starting ??= this.initialize().catch((error: unknown) => {
			this.failure = new Error('Gmail authorization failed. Check the startup error and restart the server.');
			throw error;
		});
		return this.starting;
	}

	async getAccessToken(): Promise<string> {
		if (this.failure) {
			throw this.failure;
		}

		await this.start();
		await this.reauthorizing;
		if (!this.ready || this.closed) {
			throw this.failure ?? new Error('Gmail authorization is unavailable.');
		}

		try {
			const result = await this.config.client.getAccessToken();
			if (this.closed || !this.ready) {
				throw this.failure ?? new Error('Gmail authorization is unavailable.');
			}

			if (!result.token) {
				throw new Error('No access token');
			}

			return result.token;
		} catch (error) {
			if (isRevoked(error)) {
				log('Saved Gmail authorization was revoked. Browser authorization is required.');
				this.ready = false;
				this.reauthorizing ??= this.reauthorize();
				await this.reauthorizing.catch(() => {
					this.failure = new Error('Gmail reauthorization failed. Check the startup error and restart the server.');
					log('Browser reauthorization failed.');
					throw this.failure;
				});
				return this.getAccessToken();
			}

			log('Unable to refresh Gmail access credentials.');
			throw new Error('Gmail access-token refresh failed. Try again later.');
		}
	}

	async close(): Promise<void> {
		this.closed = true;
		this.ready = false;
		this.failure = new Error('Gmail authorization is closed. Restart the server to authorize.');
		this.abort.abort();
		this.cancel?.();
		this.closingServer?.closeAllConnections();
		await this.stopListener();
		await this.exchanging?.catch(() => undefined);
		await this.saving?.catch(() => undefined);
		this.config.client.setCredentials({});
	}

	private async initialize(): Promise<void> {
		if (!await this.loadCredentials()) {
			await this.login();
		}
	}

	private async loadCredentials(): Promise<boolean> {
		let content: string;
		try {
			content = await readFile(this.config.credentialsPath, 'utf8');
		} catch (error) {
			if (hasErrorCode(error, 'ENOENT')) {
				return false;
			}

			log('Unable to read saved OAuth credentials.');
			throw new Error('Cannot read Gmail credentials. Check the credential file permissions.');
		}

		const parsed = credentialSchema.safeParse((() => {
			try {
				return JSON.parse(content) as unknown;
			} catch {
				return undefined;
			}
		})());
		if (!parsed.success) {
			log('Invalid saved OAuth credentials.');
			throw new Error('Invalid Gmail credential file. Remove it and authorize again.');
		}

		if (this.closed) {
			throw new Error('Gmail authorization is closed.');
		}

		this.config.client.setCredentials({refresh_token: parsed.data.refreshToken});
		this.ready = true;
		return true;
	}

	private async reauthorize(): Promise<void> {
		try {
			await rm(this.config.credentialsPath, {force: true});
		} catch {
			log('Unable to remove revoked OAuth credentials.');
			throw new Error('Cannot remove revoked Gmail credentials. Check file permissions.');
		}

		this.config.client.setCredentials({});
		if (!this.closed) {
			await this.login();
		}

		this.reauthorizing = undefined;
	}

	private async login(): Promise<void> {
		if (this.closed) {
			throw new Error('Gmail authorization is closed.');
		}

		const state = randomBytes(32).toString('base64url');
		const pkce = await this.config.client.generateCodeVerifierAsync();
		if (this.closed) {
			throw new Error('Gmail authorization is closed.');
		}

		return this.awaitAuthorization(state, pkce.codeVerifier, pkce.codeChallenge!);
	}

	private async awaitAuthorization(state: string, codeVerifier: string, codeChallenge: string): Promise<void> {
		this.failure = undefined;
		return new Promise<void>((resolve, reject) => {
			let consumed = false;
			const finish = (error?: Error) => {
				this.cancel = undefined;
				void this.stopListener();
				if (error) {
					this.failure = new Error(`${error.message} Restart the server to authorize.`);
					log(error.message);
					reject(error);
				} else {
					resolve();
				}
			};

			this.cancel = () => {
				consumed = true;
				finish(new Error('Gmail authorization was cancelled.'));
			};

			this.server = createServer((request, response) => {
				const code = this.validateCallback(request, response, state, consumed);
				if (!code) {
					return;
				}

				consumed = true;
				if (code.error) {
					respond(response, 400, 'Gmail authorization was denied. You may close this window.', () => {
						finish(new Error('Gmail authorization was denied.'));
					});
					return;
				}

				this.exchanging = this.exchange(code.code!, codeVerifier, response);
				void this.exchanging.then(() => {
					finish();
				}, () => {
					finish(new Error('Gmail authorization failed. Try again.'));
				});
			});
			this.server.once('error', () => {
				finish(new Error('Cannot listen for Gmail authorization. Check the callback port.'));
			});
			this.server.listen(this.config.callbackPort, '127.0.0.1', () => {
				this.setDeadline(() => {
					consumed = true;
					finish(new Error('Gmail authorization timed out. Start the server again.'));
				});
				this.launchBrowser(state, codeChallenge);
			});
		});
	}

	private setDeadline(expire: () => void): void {
		this.timer = setTimeout(() => {
			this.abort.abort();
			this.server?.closeAllConnections();
			expire();
		}, LOGIN_TIMEOUT_MS);
		this.timer.unref();
	}

	private validateCallback(request: IncomingMessage, response: ServerResponse, state: string, consumed: boolean): z.infer<typeof callbackSchema> | undefined {
		let url: URL;
		try {
			url = new URL(request.url ?? '/', 'http://localhost');
		} catch {
			respond(response, 400, 'Invalid authorization callback URL.');
			return;
		}

		if (url.pathname !== '/callback') {
			respond(response, 404, 'Not found.');
			return;
		}

		const parsed = callbackSchema.safeParse(Object.fromEntries(url.searchParams));
		const duplicate = [...url.searchParams.keys()].some((key) => url.searchParams.getAll(key).length !== 1);
		if (!parsed.success || duplicate || consumed || this.closed) {
			respond(response, 400, 'Invalid authorization callback.');
			return;
		}

		const supplied = Buffer.from(parsed.data.state);
		const expected = Buffer.from(state);
		if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected) || Boolean(parsed.data.code) === Boolean(parsed.data.error)) {
			respond(response, 400, 'Invalid authorization callback.');
			return;
		}

		return parsed.data;
	}

	private launchBrowser(state: string, challenge: string): void {
		const url = this.config.client.generateAuthUrl({
			redirect_uri: `http://localhost:${this.config.callbackPort}/callback`, state, code_challenge: challenge,
			code_challenge_method: CodeChallengeMethod.S256,
			access_type: 'offline', prompt: 'consent', scope: this.config.scopes,
		});
		log('Gmail login required. Open this authorization URL:');
		console.error(url);
		void Promise.resolve().then(async () => this.config.openBrowser(url)).catch(() => {
			log('Unable to open browser. Use the authorization URL above.');
		});
	}

	private async exchange(code: string, codeVerifier: string, response: ServerResponse): Promise<void> {
		try {
			const {tokens} = await this.config.client.getToken({code, codeVerifier, redirect_uri: `http://localhost:${this.config.callbackPort}/callback`});
			if (this.closed || !this.server) {
				throw new Error('Closed');
			}

			if (!tokens.refresh_token || !tokens.access_token) {
				throw new Error('Missing offline credentials');
			}

			this.saving = this.save(tokens.refresh_token);
			await this.saving;
			if (this.closed || !this.server) {
				throw new Error('Closed');
			}

			this.config.client.setCredentials(tokens);
			this.ready = true;
			log('Gmail authorization complete. Resuming waiting tool calls.');
			await new Promise<void>((resolve) => {
				response.once('close', resolve);
				respond(response, 200, 'Gmail authorization complete. You may close this window.', resolve);
			});
		} catch {
			log('OAuth token exchange or credential storage failed.');
			await new Promise<void>((resolve) => {
				if (response.destroyed) {
					resolve();
					return;
				}

				response.once('close', resolve);
				respond(response, 500, 'Gmail authorization failed. You may close this window.', resolve);
			});
			throw new Error('Gmail authorization failed.');
		}
	}

	private async save(refreshToken: string): Promise<void> {
		const directory = dirname(this.config.credentialsPath);
		const temporary = join(directory, `.${randomBytes(32).toString('hex')}.tmp`);
		try {
			await mkdir(directory, {recursive: true, mode: 0o700});
			await chmod(directory, 0o700);
			await writeFile(temporary, JSON.stringify({refreshToken}), {mode: 0o600, flag: 'wx'});
			if (this.closed || !this.server) {
				throw new Error('Closed');
			}

			await rename(temporary, this.config.credentialsPath);
			if (this.closed || !this.server) {
				await rm(this.config.credentialsPath, {force: true});
			}
		} finally {
			await rm(temporary, {force: true});
		}
	}

	private async stopListener(): Promise<void> {
		clearTimeout(this.timer);
		this.timer = undefined;
		const {server} = this;
		this.server = undefined;
		this.closingServer = server ?? this.closingServer;
		if (!server) {
			return this.stopping;
		}

		this.stopping = new Promise<void>((resolve) => {
			server.close(() => {
				this.closingServer = undefined;
				resolve();
			});
			server.closeAllConnections();
		});
		await this.stopping;
	}
}
