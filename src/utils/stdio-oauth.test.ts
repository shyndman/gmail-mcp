import {createHash} from 'node:crypto';
import {
	mkdtemp, readFile, readdir, rm, stat, writeFile,
} from 'node:fs/promises';
import {createServer, type Server} from 'node:http';
import {connect} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OAuth2Client} from 'google-auth-library';
import {
	afterEach, beforeEach, describe, expect, it, vi, type MockInstance,
} from 'vitest';

import {getStdioCredentialsPath, StdioOAuth} from './stdio-oauth.js';

type Deferred<T> = {promise: Promise<T>; resolve: (value: T) => void};

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return {promise, resolve};
}

async function listen(server: Server): Promise<number> {
	await new Promise<void>((resolve) => {
		server.listen(0, '127.0.0.1', resolve);
	});
	const address = server.address();
	if (!address || typeof address === 'string') {
		throw new Error('Missing listener');
	}

	return address.port;
}

async function freePort(): Promise<number> {
	const server = createServer();
	const port = await listen(server);
	await new Promise<void>((resolve) => {
		server.close(() => {
			resolve();
		});
	});
	return port;
}

describe('stdio OAuth lifecycle', () => {
	let directory: string;
	let google: Server;
	let endpoint: string;
	let port: number;
	let auth: StdioOAuth;
	let client: OAuth2Client;
	let opened: Deferred<string>;
	let browser: (url: string) => Promise<void>;
	let requests: URLSearchParams[];
	let reply: (body: URLSearchParams) => Promise<{status: number; data: object}>;
	let logs: MockInstance<typeof console.error>;
	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), 'gmail-stdio-oauth-'));
		port = await freePort();
		requests = [];
		opened = deferred<string>();
		logs = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		browser = async (url) => {
			opened.resolve(url);
		};

		reply = async () => ({
			status: 200, data: {
				access_token: 'access-one', refresh_token: 'refresh-one', expires_in: 3600, token_type: 'Bearer',
			},
		});
		google = createServer((request, response) => {
			void (async () => {
				let content = '';
				for await (const chunk of request) {
					content += String(chunk);
				}

				const body = new URLSearchParams(content);
				requests.push(body);
				const result = await reply(body);
				response.writeHead(result.status, {'Content-Type': 'application/json'});
				response.end(JSON.stringify(result.data));
			})();
		});
		endpoint = `http://127.0.0.1:${await listen(google)}/token`;
		makeAuth();
	});

	function makeAuth(path = join(directory, 'credentials.json')): void {
		client = new OAuth2Client({
			clientId: 'test-client', clientSecret: 'test-secret', redirectUri: `http://localhost:${port}/callback`, endpoints: {oauth2TokenUrl: endpoint},
		});
		auth = new StdioOAuth({
			client, callbackPort: port, scopes: ['scope-read'], credentialsPath: path, openBrowser: async (url) => browser(url),
		});
	}

	async function callback(url: string, fields: Record<string, string> = {code: 'google-code'}): Promise<Response> {
		const state = new URL(url).searchParams.get('state')!;
		return fetch(`http://127.0.0.1:${port}/callback?${new URLSearchParams({state, ...fields}).toString()}`);
	}

	async function authorize(): Promise<string> {
		const started = auth.start();
		const url = await opened.promise;
		expect((await callback(url)).status).toBe(200);
		await started;
		return url;
	}

	afterEach(async () => {
		vi.useRealTimers();
		await auth.close();
		await new Promise<void>((resolve) => {
			google.close(() => {
				resolve();
			});
			google.closeAllConnections();
		});
		await rm(directory, {recursive: true, force: true});
		vi.restoreAllMocks();
	});

	it('starts once, fails pending calls immediately, validates state and exchanges library PKCE', async () => {
		let browserCalls = 0;
		browser = async (url) => {
			browserCalls += 1;
			opened.resolve(url);
		};

		const started = auth.start();
		const secondStart = auth.start();
		await expect(auth.getAccessToken()).rejects.toThrow('authorization pending');
		const url = await opened.promise;
		const params = new URL(url).searchParams;
		expect(params.get('scope')).toBe('scope-read');
		expect(params.get('access_type')).toBe('offline');
		expect(params.get('prompt')).toBe('consent');
		expect(params.get('code_challenge_method')).toBe('S256');
		expect(params.get('redirect_uri')).toBe(`http://localhost:${port}/callback`);
		expect((await callback(url, {state: 'forged', code: 'google-code'})).status).toBe(400);
		expect(requests).toHaveLength(0);
		expect((await callback(url)).status).toBe(200);
		await Promise.all([started, secondStart]);
		expect(browserCalls).toBe(1);
		expect(requests).toHaveLength(1);
		expect(createHash('sha256').update(requests[0]!.get('code_verifier')!).digest('base64url')).toBe(params.get('code_challenge'));
		expect(await auth.getAccessToken()).toBe('access-one');
		expect(JSON.parse(await readFile(join(directory, 'credentials.json'), 'utf8'))).toEqual({refreshToken: 'refresh-one'});
		expect((await stat(directory)).mode % 0o1000).toBe(0o700);
		expect((await stat(join(directory, 'credentials.json'))).mode % 0o1000).toBe(0o600);
		await expect(callback(url)).rejects.toThrow();
	});

	it.each<Record<string, string>>([{code: ''}, {}, {code: 'code', error: 'denied'}])('rejects malformed callback without consuming attempt: %j', async (fields) => {
		const started = auth.start();
		const url = await opened.promise;
		expect((await callback(url, fields)).status).toBe(400);
		expect((await fetch(`http://127.0.0.1:${port}/elsewhere`)).status).toBe(404);
		expect(requests).toHaveLength(0);
		expect((await callback(url)).status).toBe(200);
		await started;
	});

	it('consumes denial and closes the listener', async () => {
		const started = auth.start();
		const rejected = expect(started).rejects.toThrow('denied');
		const url = await opened.promise;
		expect((await callback(url, {error: 'access_denied'})).status).toBe(400);
		await rejected;
		expect(requests).toHaveLength(0);
		await expect(callback(url)).rejects.toThrow();
	});

	it('keeps manual authorization usable after browser launch fails', async () => {
		browser = async (url) => {
			opened.resolve(url);
			throw new Error('secret upstream detail');
		};

		await authorize();
		expect(logs.mock.calls.flat().join(' ')).not.toContain('secret upstream detail');
	});

	it('loads cached credentials without opening a browser or callback listener and shares refreshes', async () => {
		await writeFile(join(directory, 'credentials.json'), JSON.stringify({refreshToken: 'saved-refresh'}));
		await auth.start();
		await expect(fetch(`http://127.0.0.1:${port}/callback`)).rejects.toThrow();
		const gate = deferred<void>();
		reply = async () => {
			await gate.promise;
			return {status: 200, data: {access_token: 'refreshed', expires_in: 3600}};
		};

		const calls = [auth.getAccessToken(), auth.getAccessToken(), auth.getAccessToken()];
		gate.resolve();
		expect(await Promise.all(calls)).toEqual(['refreshed', 'refreshed', 'refreshed']);
		expect(requests).toHaveLength(1);
		expect(requests[0]!.get('grant_type')).toBe('refresh_token');
		client.credentials.expiry_date = Date.now() + 1000;
		expect(await auth.getAccessToken()).toBe('refreshed');
		expect(requests).toHaveLength(2);
	});

	it('separates credential caches by client and scope set', () => {
		expect(getStdioCredentialsPath('one', ['a', 'b'])).toBe(getStdioCredentialsPath('one', ['b', 'a']));
		expect(getStdioCredentialsPath('one', ['a'])).not.toBe(getStdioCredentialsPath('one', ['a', 'b']));
		expect(getStdioCredentialsPath('one', ['a'])).not.toBe(getStdioCredentialsPath('two', ['a']));
	});

	it.each(['not-json', '{"refreshToken":""}', '{"refreshToken":"secret","accessToken":"secret"}'])('fails safely for invalid caches', async (content) => {
		await writeFile(join(directory, 'credentials.json'), content);
		await expect(auth.start()).rejects.toThrow('Invalid Gmail credential file');
		expect(requests).toHaveLength(0);
		expect(logs.mock.calls.flat().join(' ')).not.toContain('secret');
	});

	it('does not treat cache read errors as missing credentials', async () => {
		makeAuth(directory);
		await expect(auth.start()).rejects.toThrow('Cannot read Gmail credentials');
	});

	it('fails credential persistence without leaving temporary files', async () => {
		makeAuth(join(directory, 'blocked', 'cache.json'));
		const started = auth.start();
		const rejected = expect(started).rejects.toThrow('authorization failed');
		const url = await opened.promise;
		await writeFile(join(directory, 'blocked'), 'not a directory');
		expect((await callback(url)).status).toBe(500);
		await rejected;
		expect(await readdir(directory)).toEqual(['blocked']);
		await expect(auth.getAccessToken()).rejects.toThrow('restart');
	});

	it('reauthorizes revoked refresh credentials once without blocking tool calls', async () => {
		await writeFile(join(directory, 'credentials.json'), '{"refreshToken":"revoked"}');
		await auth.start();
		reply = async () => ({status: 400, data: {error: 'invalid_grant', error_description: 'secret'}});
		await expect(auth.getAccessToken()).rejects.toThrow('authorization pending');
		const url = await opened.promise;
		await expect(auth.getAccessToken()).rejects.toThrow('authorization pending');
		await expect(readFile(join(directory, 'credentials.json'))).rejects.toMatchObject({code: 'ENOENT'});
		reply = async () => ({status: 200, data: {access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600}});
		expect((await callback(url)).status).toBe(200);
		expect(await auth.getAccessToken()).toBe('new-access');
		expect(logs.mock.calls.flat().join(' ')).not.toContain('secret');
	});

	it('retains cache on generic upstream refresh failure', async () => {
		await writeFile(join(directory, 'credentials.json'), '{"refreshToken":"saved"}');
		await auth.start();
		reply = async () => ({status: 400, data: {error: 'invalid_request', error_description: 'private-detail'}});
		await expect(auth.getAccessToken()).rejects.toThrow('refresh failed');
		expect(await readFile(join(directory, 'credentials.json'), 'utf8')).toBe('{"refreshToken":"saved"}');
		expect(logs.mock.calls.flat().join(' ')).not.toContain('private-detail');
	});

	it('times out while leaving HTTP timers real', async () => {
		const realSetTimeout = globalThis.setTimeout;
		let expire!: () => void;
		vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
			if (delay === 10 * 60 * 1000) {
				expire = () => {
					handler(...args);
				};
			}

			return realSetTimeout(handler, delay, ...args);
		}) as typeof setTimeout);
		const started = auth.start();
		const rejected = expect(started).rejects.toThrow('timed out');
		const url = await opened.promise;
		expire();
		await rejected;
		await expect(callback(url)).rejects.toThrow();
	});

	it('closes during pending browser login', async () => {
		const started = auth.start();
		const rejected = expect(started).rejects.toThrow('cancelled');
		const url = await opened.promise;
		await auth.close();
		await rejected;
		await expect(callback(url)).rejects.toThrow();
	});

	it('rejects exchanges missing offline credentials and closes callback', async () => {
		reply = async () => ({status: 200, data: {access_token: 'only-access'}});
		const started = auth.start();
		const rejected = expect(started).rejects.toThrow('authorization failed');
		const url = await opened.promise;
		expect((await callback(url)).status).toBe(500);
		await rejected;
		await expect(callback(url)).rejects.toThrow();
	});

	it('rejects concurrent callback replay before Google finishes', async () => {
		const reached = deferred<void>();
		const release = deferred<void>();
		reply = async () => {
			reached.resolve();
			await release.promise;
			return {status: 200, data: {access_token: 'access', refresh_token: 'refresh', expires_in: 3600}};
		};

		const started = auth.start();
		const url = await opened.promise;
		const first = callback(url);
		await reached.promise;
		expect((await callback(url)).status).toBe(400);
		expect(requests).toHaveLength(1);
		release.resolve();
		expect((await first).status).toBe(200);
		await started;
	});

	it('fails safely on Google exchange errors', async () => {
		reply = async () => ({status: 400, data: {error: 'invalid_grant', error_description: 'private-google-detail'}});
		const started = auth.start();
		const rejected = expect(started).rejects.toThrow('authorization failed');
		const url = await opened.promise;
		expect((await callback(url)).status).toBe(500);
		await rejected;
		expect(logs.mock.calls.flat().join(' ')).not.toContain('private-google-detail');
		await expect(readFile(join(directory, 'credentials.json'))).rejects.toMatchObject({code: 'ENOENT'});
	});

	it('reports an occupied callback port without launching a browser', async () => {
		const occupied = createServer();
		await new Promise<void>((resolve) => {
			occupied.listen(port, '127.0.0.1', resolve);
		});
		try {
			await expect(auth.start()).rejects.toThrow('callback port');
			expect(requests).toHaveLength(0);
		} finally {
			await new Promise<void>((resolve) => {
				occupied.close(() => {
					resolve();
				});
			});
		}
	});

	it('rejects malformed request URLs without terminating browser authorization', async () => {
		const started = auth.start();
		const url = await opened.promise;
		const socket = connect(port, '127.0.0.1');
		let content = '';
		await new Promise<void>((resolve, reject) => {
			socket.once('error', reject);
			socket.on('data', (chunk: Buffer) => {
				content += chunk.toString();
			});
			socket.once('end', resolve);
			socket.once('connect', () => {
				socket.end('GET //[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
			});
		});
		expect(content).toContain('400');
		expect(requests).toHaveLength(0);
		expect((await callback(url)).status).toBe(200);
		await started;
	});

	it('aborts a stalled library refresh on shutdown', async () => {
		await writeFile(join(directory, 'credentials.json'), '{"refreshToken":"saved"}');
		await auth.start();
		const reached = deferred<void>();
		const release = deferred<void>();
		const disconnected = deferred<void>();
		google.once('request', (_request, response) => {
			response.once('close', () => {
				disconnected.resolve();
			});
		});
		reply = async () => {
			reached.resolve();
			await release.promise;
			return {status: 200, data: {access_token: 'late-refresh'}};
		};

		const token = auth.getAccessToken();
		const rejection = expect(token).rejects.toThrow('refresh failed');
		await reached.promise;
		await auth.close();
		await disconnected.promise;
		await rejection;
		release.resolve();
		await expect(auth.getAccessToken()).rejects.toThrow('Restart');
	});

	it('cancels pending login and prevents late exchange credentials from being saved', async () => {
		const reached = deferred<void>();
		const disconnected = deferred<void>();
		google.once('request', (_request, response) => {
			response.once('close', () => {
				disconnected.resolve();
			});
		});
		const release = deferred<void>();
		reply = async () => {
			reached.resolve();
			await release.promise;
			return {status: 200, data: {access_token: 'late', refresh_token: 'late'}};
		};

		const started = auth.start();
		const rejected = expect(started).rejects.toThrow('cancelled');
		const url = await opened.promise;
		const response = callback(url).catch(() => undefined);
		await reached.promise;
		await auth.close();
		release.resolve();
		await disconnected.promise;
		await response;
		await rejected;
		await expect(auth.getAccessToken()).rejects.toThrow('Restart');
		await expect(readFile(join(directory, 'credentials.json'))).rejects.toMatchObject({code: 'ENOENT'});
	});

	it.each(['denial', 'success'])('closes incomplete HTTP sockets after terminal %s', async (outcome) => {
		const started = auth.start();
		const completion = outcome === 'denial'
			? expect(started).rejects.toThrow('denied')
			: started;
		const url = await opened.promise;
		const socket = connect(port, '127.0.0.1');
		await new Promise<void>((resolve, reject) => {
			socket.once('connect', resolve);
			socket.once('error', reject);
		});
		socket.resume();
		socket.write('GET /callback HTTP/1.1\r\nHost: localhost\r\n');
		const socketClosed = new Promise<void>((resolve) => {
			socket.once('close', () => {
				resolve();
			});
		});
		try {
			expect(socket.destroyed).toBe(false);
			await callback(url, outcome === 'denial' ? {error: 'access_denied'} : {code: 'google-code'});
			await completion;
			await socketClosed;
			await auth.close();
		} finally {
			socket.destroy();
		}
	});
});
