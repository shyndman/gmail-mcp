import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';
import type {Express, Response} from 'express';
import {
	OAuthClientMetadataSchema, type OAuthClientMetadata, type OAuthMetadata, type OAuthProtectedResourceMetadata,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import {z} from 'zod';

export type OAuthProxyConfig = {
	baseUrl: string;
	googleClientId: string;
	googleClientSecret: string;
	scopes: string[];
};

const OAUTH_RANDOM_BYTES = 32;
const OAUTH_TRANSACTION_TTL_MS = 10 * 60 * 1000;
const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

type AuthorizationTransaction = {
	clientId: string;
	redirectUri: string;
	clientState: string | undefined;
	codeChallenge: string;
	browserBinding: string;
	expiresAt: number;
};
type AuthorizationCode = {
	googleCode: string;
	clientId: string;
	redirectUri: string;
	codeChallenge: string;
	expiresAt: number;
};

const authorizationSchema = z.object({
	response_type: z.literal('code'),
	client_id: z.string().min(1),
	redirect_uri: z.string().min(1),
	code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/).refine((value) => {
		const decoded = Buffer.from(value, 'base64url');
		return decoded.length === 32 && decoded.toString('base64url') === value;
	}),
	code_challenge_method: z.literal('S256'),
	state: z.string().optional(),
	scope: z.string().optional(),
});
const codeRequestSchema = z.object({
	grant_type: z.literal('authorization_code'),
	client_id: z.string().min(1),
	code: z.string().min(1),
	redirect_uri: z.string().min(1),
	code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
});
const refreshRequestSchema = z.object({
	grant_type: z.literal('refresh_token'),
	client_id: z.string().min(1),
	refresh_token: z.string().min(1),
});

function randomValue(): string {
	return randomBytes(OAUTH_RANDOM_BYTES).toString('base64url');
}

function removeExpired<T extends {expiresAt: number}>(entries: Map<string, T>): void {
	const now = Date.now();
	for (const [key, entry] of entries) {
		if (entry.expiresAt <= now) {
			entries.delete(key);
		}
	}
}

function permittedRedirect(value: string): boolean {
	try {
		const url = new URL(value);
		const authority = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/.exec(value)?.[1];
		return authority !== undefined && authority.length > 0 && !authority.includes('@')
			&& !url.username && !url.password && !value.includes('#')
			&& (url.protocol === 'https:' || (url.protocol === 'http:'
				&& ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)));
	} catch {
		return false;
	}
}

function fail(res: Response, error: string, reason: string, status = 400): void {
	console.error(`gmail-mcp: OAuth ${reason}`);
	res.status(status).json({error});
}

function callbackUrl(transaction: AuthorizationTransaction, field: 'code' | 'error', value: string): string {
	const url = new URL(transaction.redirectUri);
	for (const name of ['code', 'error', 'error_description', 'state']) {
		url.searchParams.delete(name);
	}

	url.searchParams.set(field, value);
	if (transaction.clientState !== undefined) {
		url.searchParams.set('state', transaction.clientState);
	}

	return url.toString();
}

export function registerOAuthRoutes(app: Express, config: OAuthProxyConfig): void {
	const clients = new Map<string, OAuthClientMetadata>();
	const transactions = new Map<string, AuthorizationTransaction>();
	const codes = new Map<string, AuthorizationCode>();
	const callback = `${config.baseUrl}/callback`;
	const cookieOptions = {
		httpOnly: true, sameSite: 'lax' as const, path: '/callback', secure: new URL(config.baseUrl).protocol === 'https:',
	};
	const metadata: OAuthMetadata = {
		issuer: config.baseUrl,
		authorization_endpoint: `${config.baseUrl}/authorize`,
		token_endpoint: `${config.baseUrl}/token`,
		registration_endpoint: `${config.baseUrl}/register`,
		response_types_supported: ['code'],
		grant_types_supported: ['authorization_code', 'refresh_token'],
		code_challenge_methods_supported: ['S256'],
		token_endpoint_auth_methods_supported: ['none'],
		scopes_supported: config.scopes,
	};
	const resourceMetadata: OAuthProtectedResourceMetadata = {
		resource: `${config.baseUrl}/mcp`, authorization_servers: [config.baseUrl], scopes_supported: config.scopes,
		resource_name: 'Gmail MCP Server', resource_documentation: 'https://github.com/domdomegg/gmail-mcp',
	};
	app.get('/.well-known/oauth-authorization-server', (_req, res) => res.json(metadata));
	app.get('/.well-known/oauth-protected-resource', (_req, res) => res.json(resourceMetadata));
	app.get('/.well-known/oauth-protected-resource/mcp', (_req, res) => res.json(resourceMetadata));

	app.post('/register', (req, res) => {
		// The SDK URL schema normalizes URLs; validate and retain the original callback strings.
		const rawRedirects = z.object({redirect_uris: z.array(z.string()).min(1)}).safeParse(req.body);
		if (!rawRedirects.success || !rawRedirects.data.redirect_uris.every(permittedRedirect)) {
			fail(res, 'invalid_client_metadata', 'registration redirects rejected');
			return;
		}

		const parsed = OAuthClientMetadataSchema.safeParse(req.body);
		if (!parsed.success) {
			fail(res, 'invalid_client_metadata', 'registration metadata rejected');
			return;
		}

		const metadata = {...parsed.data, redirect_uris: rawRedirects.data.redirect_uris};
		const grants = metadata.grant_types ?? ['authorization_code', 'refresh_token'];
		const responses = metadata.response_types ?? ['code'];
		if (metadata.redirect_uris.length === 0 || !metadata.redirect_uris.every(permittedRedirect)
			|| (metadata.token_endpoint_auth_method !== undefined && metadata.token_endpoint_auth_method !== 'none')
			|| !grants.includes('authorization_code') || grants.some((grant) => !['authorization_code', 'refresh_token'].includes(grant))
			|| responses.length !== 1 || responses[0] !== 'code') {
			fail(res, 'invalid_client_metadata', 'unsupported registration metadata');
			return;
		}

		const clientId = randomValue();
		const resolved = {
			...metadata, token_endpoint_auth_method: 'none', grant_types: grants, response_types: responses,
		};
		clients.set(clientId, resolved);
		res.status(201).json({...resolved, client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000)});
	});

	app.get('/authorize', (req, res) => {
		const parsed = authorizationSchema.safeParse(req.query);
		if (!parsed.success) {
			fail(res, 'invalid_request', 'authorization fields rejected');
			return;
		}

		const request = parsed.data;
		const client = clients.get(request.client_id);
		if (!client) {
			fail(res, 'invalid_client', 'unknown authorization client');
			return;
		}

		if (!client.redirect_uris.includes(request.redirect_uri)) {
			fail(res, 'invalid_request', 'unregistered authorization redirect');
			return;
		}

		if (request.scope?.split(/\s+/).filter(Boolean).some((scope) => !config.scopes.includes(scope))) {
			fail(res, 'invalid_scope', 'authorization scope rejected');
			return;
		}

		removeExpired(transactions);
		const state = randomValue();
		const browserBinding = randomValue();
		transactions.set(state, {
			clientId: request.client_id, redirectUri: request.redirect_uri, clientState: request.state,
			codeChallenge: request.code_challenge, browserBinding, expiresAt: Date.now() + OAUTH_TRANSACTION_TTL_MS,
		});
		res.cookie(`gmail_mcp_oauth_${state}`, browserBinding, {...cookieOptions, maxAge: OAUTH_TRANSACTION_TTL_MS});
		const params = new URLSearchParams({
			client_id: config.googleClientId, redirect_uri: callback, response_type: 'code', scope: config.scopes.join(' '),
			access_type: 'offline', prompt: 'consent', state, code_challenge: request.code_challenge, code_challenge_method: 'S256',
		});
		res.redirect(`${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`);
	});

	app.get('/callback', (req, res) => {
		removeExpired(transactions);
		const state = typeof req.query.state === 'string' ? req.query.state : '';
		const transaction = transactions.get(state);
		const cookieName = `gmail_mcp_oauth_${state}`;
		const cookieValues = (req.headers.cookie ?? '').split(';').map((value) => value.trim())
			.filter((value) => value.startsWith(`${cookieName}=`)).map((value) => value.slice(cookieName.length + 1));
		if (!transaction || cookieValues.length !== 1 || cookieValues[0] !== transaction.browserBinding) {
			fail(res, 'invalid_state', 'callback browser binding rejected');
			return;
		}

		transactions.delete(state);
		res.clearCookie(cookieName, cookieOptions);
		const parsed = z.object({code: z.string().min(1).optional(), error: z.string().min(1).optional()}).safeParse(req.query);
		if (!parsed.success || (parsed.data.code === undefined) === (parsed.data.error === undefined)) {
			fail(res, 'invalid_request', 'callback result rejected');
			return;
		}

		if (parsed.data.error !== undefined) {
			console.error('gmail-mcp: OAuth upstream authorization denied');
			res.redirect(callbackUrl(transaction, 'error', parsed.data.error));
			return;
		}

		removeExpired(codes);
		const code = randomValue();
		codes.set(code, {
			googleCode: parsed.data.code!, clientId: transaction.clientId, redirectUri: transaction.redirectUri,
			codeChallenge: transaction.codeChallenge, expiresAt: Date.now() + OAUTH_TRANSACTION_TTL_MS,
		});
		res.redirect(callbackUrl(transaction, 'code', code));
	});

	app.post('/token', async (req, res) => {
		res.set('Cache-Control', 'no-store');
		const grant = z.object({grant_type: z.string().min(1)}).safeParse(req.body);
		if (!grant.success) {
			fail(res, 'invalid_request', 'token grant fields rejected');
			return;
		}

		let parameters: URLSearchParams;
		if (grant.data.grant_type === 'authorization_code') {
			const parsed = codeRequestSchema.safeParse(req.body);
			if (!parsed.success) {
				fail(res, 'invalid_request', 'token code fields rejected');
				return;
			}

			const request = parsed.data;
			if (!clients.has(request.client_id)) {
				fail(res, 'invalid_client', 'unknown token client');
				return;
			}

			removeExpired(codes);
			const code = codes.get(request.code);
			const challenge = createHash('sha256').update(request.code_verifier).digest();
			const expected = code ? Buffer.from(code.codeChallenge, 'base64url') : undefined;
			if (!code || code.clientId !== request.client_id || code.redirectUri !== request.redirect_uri
				|| !expected || expected.length !== challenge.length || !timingSafeEqual(expected, challenge)) {
				fail(res, 'invalid_grant', 'token code binding rejected');
				return;
			}

			codes.delete(request.code);
			parameters = new URLSearchParams({
				grant_type: 'authorization_code', code: code.googleCode,
				code_verifier: request.code_verifier, redirect_uri: callback,
			});
		} else if (grant.data.grant_type === 'refresh_token') {
			const parsed = refreshRequestSchema.safeParse(req.body);
			if (!parsed.success) {
				fail(res, 'invalid_request', 'token refresh fields rejected');
				return;
			}

			if (!clients.has(parsed.data.client_id)) {
				fail(res, 'invalid_client', 'unknown refresh client');
				return;
			}

			parameters = new URLSearchParams({grant_type: 'refresh_token', refresh_token: parsed.data.refresh_token});
		} else {
			fail(res, 'unsupported_grant_type', 'unsupported token grant');
			return;
		}

		parameters.set('client_id', config.googleClientId);
		parameters.set('client_secret', config.googleClientSecret);
		try {
			const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
				method: 'POST',
				headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: parameters.toString(),
			});
			const data: unknown = await response.json();
			if (!response.ok) {
				console.error('gmail-mcp: OAuth upstream token request rejected');
			}

			res.status(response.status).json(data);
		} catch {
			fail(res, 'server_error', 'upstream token exchange failed', 500);
		}
	});
}
