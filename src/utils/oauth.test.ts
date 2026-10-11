import {createHash} from 'node:crypto';
import type {Server} from 'node:http';
import express from 'express';
import {
	afterEach, beforeEach, describe, expect, it, vi, type MockInstance,
} from 'vitest';
import {registerOAuthRoutes} from './oauth.js';

const TTL = 10 * 60 * 1000;
const verifier = 'v'.repeat(43);
const challenge = createHash('sha256').update(verifier).digest('base64url');
const redirectUri = 'http://127.0.0.1:49123/callback?existing=1&code=old&error=old&error_description=old&state=old';
const scopes = ['https://www.googleapis.com/auth/gmail.readonly'];

describe('OAuth proxy security boundary', () => {
	let server: Server;
	let baseUrl: string;
	const realFetch = globalThis.fetch;
	const googleFetch = vi.fn<typeof fetch>();
	let errorLog: MockInstance;

	beforeEach(async () => {
		googleFetch.mockReset();
		googleFetch.mockResolvedValue(new Response(JSON.stringify({access_token: 'google-token'}), {status: 200}));
		errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		vi.useFakeTimers({toFake: ['Date']});
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
		const app = express();
		app.use(express.json());
		app.use(express.urlencoded({extended: true}));
		server = app.listen(0, '127.0.0.1');
		await new Promise<void>((resolve) => {
			server.once('listening', resolve);
		});
		const address = server.address();
		if (!address || typeof address === 'string') {
			throw new Error('Expected TCP listener');
		}

		baseUrl = `http://127.0.0.1:${address.port}`;
		registerOAuthRoutes(app, {
			baseUrl, googleClientId: 'server-client', googleClientSecret: 'server-secret', scopes,
		});
		vi.stubGlobal('fetch', googleFetch);
	});

	afterEach(async () => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
		errorLog.mockRestore();
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => {
			server.close((error) => {
				if (error) {
					reject(error);
				} else {
					resolve();
				}
			});
		});
	});

	async function request(path: string, body?: Record<string, unknown>, cookie?: string): Promise<Response> {
		return realFetch(`${baseUrl}${path}`, {
			redirect: 'manual', method: body ? 'POST' : 'GET',
			headers: {'Content-Type': 'application/json', ...(cookie ? {Cookie: cookie} : {})},
			...(body ? {body: JSON.stringify(body)} : {}),
		});
	}

	async function register(uri = redirectUri): Promise<string> {
		const response = await request('/register', {redirect_uris: [uri]});
		expect(response.status).toBe(201);
		const data = await response.json() as {client_id: string};
		return data.client_id;
	}

	async function authorize(clientId: string, extra: Record<string, string> = {}): Promise<Response> {
		const query = new URLSearchParams({
			response_type: 'code', client_id: clientId, redirect_uri: redirectUri,
			code_challenge: challenge, code_challenge_method: 'S256', state: 'client-state', ...extra,
		});
		return request(`/authorize?${query.toString()}`);
	}

	async function transaction(clientId: string, extra: Record<string, string> = {}): Promise<{state: string; cookie: string}> {
		const response = await authorize(clientId, extra);
		expect(response.status).toBe(302);
		const location = new URL(response.headers.get('location')!);
		const state = location.searchParams.get('state')!;
		const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
		expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(location.searchParams.get('redirect_uri')).toBe(`${baseUrl}/callback`);
		expect(location.searchParams.get('scope')).toBe(scopes.join(' '));
		expect(response.headers.get('set-cookie')).toContain('HttpOnly');
		expect(response.headers.get('set-cookie')).toContain('SameSite=Lax');
		expect(response.headers.get('set-cookie')).toContain('Path=/callback');
		expect(response.headers.get('set-cookie')).toContain('Max-Age=600');
		return {state, cookie};
	}

	async function issueCode(clientId: string): Promise<string> {
		const {state, cookie} = await transaction(clientId);
		const response = await request(`/callback?state=${state}&code=real-google-code`, undefined, cookie);
		expect(response.status).toBe(302);
		const location = new URL(response.headers.get('location')!);
		expect(location.searchParams.get('existing')).toBe('1');
		expect(location.searchParams.get('state')).toBe('client-state');
		expect(location.searchParams.has('error')).toBe(false);
		expect(location.searchParams.has('error_description')).toBe(false);
		const code = location.searchParams.get('code')!;
		expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(code).not.toBe('real-google-code');
		return code;
	}

	async function exchange(clientId: string, code: string, extra: Record<string, string> = {}): Promise<Response> {
		return request('/token', {
			grant_type: 'authorization_code', client_id: clientId, code,
			redirect_uri: redirectUri, code_verifier: verifier, ...extra,
		});
	}

	async function expectError(response: Response, error: string, status = 400): Promise<void> {
		expect(response.status).toBe(status);
		expect(await response.json()).toEqual({error});
		expect(response.headers.has('location')).toBe(false);
	}

	it('registers unique public clients with exact redirect strings and strips supplied credentials', async () => {
		const response = await request('/register', {redirect_uris: [redirectUri], client_id: 'injected', client_secret: 'injected'});
		const data = await response.json() as Record<string, unknown>;
		expect(response.status).toBe(201);
		expect(data).toMatchObject({
			redirect_uris: [redirectUri], token_endpoint_auth_method: 'none',
			grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], client_id_issued_at: Date.now() / 1000,
		});
		expect(data.client_id).not.toBe(await register());
		expect(data.client_secret).toBeUndefined();
		expect(JSON.stringify(data)).not.toContain('server-secret');
	});

	it('retains raw redirect spelling rather than accepting its normalized equivalent', async () => {
		const raw = 'https://EXAMPLE.com:443/callback?existing=%31';
		const response = await request('/register', {redirect_uris: [raw]});
		const data = await response.json() as {client_id: string; redirect_uris: string[]};
		expect(response.status).toBe(201);
		expect(data.redirect_uris).toEqual([raw]);
		expect((await authorize(data.client_id, {redirect_uri: raw})).status).toBe(302);
		await expectError(await authorize(data.client_id, {redirect_uri: new URL(raw).toString()}), 'invalid_request');
	});

	it.each(['https://example.com/callback', 'http://localhost:49123/callback', 'http://[::1]:49123/callback'])('accepts safe redirect %s', async (uri) => {
		await register(uri);
	});

	it.each(['http://attacker.invalid/callback',
		'custom://callback',
		'ftp://example.com/callback',
		'https://user@example.com/callback',
		'https://@example.com/callback',
		'https:////user@example.com/callback',
		'https:////@example.com/callback',
		'https://example.com/callback#',
		'https://example.com/callback#fragment',
		'not-a-url'])('rejects unsafe redirect %s', async (uri) => {
		await expectError(await request('/register', {redirect_uris: [uri]}), 'invalid_client_metadata');
	});

	it.each([{},
		{redirect_uris: []},
		{redirect_uris: [redirectUri], token_endpoint_auth_method: 'client_secret_basic'},
		{redirect_uris: [redirectUri], grant_types: []},
		{redirect_uris: [redirectUri], grant_types: ['refresh_token']},
		{redirect_uris: [redirectUri], grant_types: ['authorization_code', 'password']},
		{redirect_uris: [redirectUri], response_types: []},
		{redirect_uris: [redirectUri], response_types: ['code', 'token']}])('rejects unsupported registration metadata %#', async (body) => {
		await expectError(await request('/register', body), 'invalid_client_metadata');
	});

	it('advertises selected scopes and public authentication on all metadata routes', async () => {
		const metadata = await (await request('/.well-known/oauth-authorization-server')).json() as Record<string, unknown>;
		expect(metadata.scopes_supported).toEqual(scopes);
		expect(metadata.token_endpoint_auth_methods_supported).toEqual(['none']);
		await Promise.all(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'].map(async (path) => {
			expect(await (await request(path)).json()).toMatchObject({scopes_supported: scopes});
		}));
	});

	it.each([{client_id: 'unknown'},
		{redirect_uri: `${redirectUri}&other=1`},
		{code_challenge: ''},
		{code_challenge_method: 'plain'},
		{code_challenge: `${'A'.repeat(42)}B`},
		{response_type: 'token'},
		{scope: 'https://www.googleapis.com/auth/gmail.send'}])('rejects invalid authorization without redirect %#', async (extra) => {
		const clientId = await register();
		await expectError(await authorize(clientId, extra as Record<string, string>), extra.client_id ? 'invalid_client' : extra.scope ? 'invalid_scope' : 'invalid_request');
		expect(googleFetch).not.toHaveBeenCalled();
	});

	it('uses Secure cookies for HTTPS advertised URLs', async () => {
		const app = express();
		app.use(express.json());
		registerOAuthRoutes(app, {
			baseUrl: 'https://proxy.example', googleClientId: 'server-client', googleClientSecret: 'server-secret', scopes,
		});
		const secureServer = app.listen(0, '127.0.0.1');
		await new Promise<void>((resolve) => {
			secureServer.once('listening', resolve);
		});
		const address = secureServer.address();
		if (!address || typeof address === 'string') {
			throw new Error('Expected TCP listener');
		}

		const origin = `http://127.0.0.1:${address.port}`;
		try {
			const registration = await realFetch(`${origin}/register`, {
				method: 'POST',
				headers: {'Content-Type': 'application/json'}, body: JSON.stringify({redirect_uris: [redirectUri]}),
			});
			const data = await registration.json() as {client_id: string};
			const query = new URLSearchParams({
				response_type: 'code', client_id: data.client_id, redirect_uri: redirectUri,
				code_challenge: challenge, code_challenge_method: 'S256',
			});
			const response = await realFetch(`${origin}/authorize?${query.toString()}`, {redirect: 'manual'});
			expect(response.headers.get('set-cookie')).toContain('Secure');
			expect(new URL(response.headers.get('location')!).searchParams.get('redirect_uri')).toBe('https://proxy.example/callback');
		} finally {
			secureServer.closeAllConnections();
			await new Promise<void>((resolve, reject) => {
				secureServer.close((error) => {
					if (error) {
						reject(error);
					} else {
						resolve();
					}
				});
			});
		}
	});

	it('requires all authorization fields and accepts scope subsets', async () => {
		const clientId = await register();
		await expectError(await request(`/authorize?client_id=${clientId}`), 'invalid_request');
		expect((await authorize(clientId, {scope: scopes[0]!})).status).toBe(302);
	});

	it('rejects forged, missing and wrong browser binding without consuming legitimate state', async () => {
		await expectError(await request('/callback?state=forged&code=evil'), 'invalid_state');
		const {state, cookie} = await transaction(await register());
		await expectError(await request(`/callback?state=${state}&code=real-google-code`), 'invalid_state');
		await expectError(await request(`/callback?state=${state}&code=real-google-code`, undefined, `gmail_mcp_oauth_${state}=wrong`), 'invalid_state');
		expect((await request(`/callback?state=${state}&code=real-google-code`, undefined, cookie)).status).toBe(302);
		await expectError(await request(`/callback?state=${state}&code=real-google-code`, undefined, cookie), 'invalid_state');
	});

	it('expires browser transactions at the TTL boundary', async () => {
		const {state, cookie} = await transaction(await register());
		vi.setSystemTime(Date.now() + TTL);
		await expectError(await request(`/callback?state=${state}&code=google`, undefined, cookie), 'invalid_state');
	});

	it('keeps parallel browser transactions independent', async () => {
		const clientId = await register();
		const first = await transaction(clientId);
		const second = await transaction(clientId);
		expect(first.state).not.toBe(second.state);
		await Promise.all([first, second].map(async (entry) => {
			expect((await request(`/callback?state=${entry.state}&code=google`, undefined, `${first.cookie}; ${second.cookie}`)).status).toBe(302);
		}));
	});

	it.each(['', '&code=google&error=access_denied', '&code=', '&error='])('consumes bound invalid callback results %s', async (suffix) => {
		const {state, cookie} = await transaction(await register());
		await expectError(await request(`/callback?state=${state}${suffix}`, undefined, cookie), 'invalid_request');
		await expectError(await request(`/callback?state=${state}&code=google`, undefined, cookie), 'invalid_state');
		expect(googleFetch).not.toHaveBeenCalled();
	});

	it('returns Google denial with preserved empty state and removes obsolete result fields', async () => {
		const {state, cookie} = await transaction(await register(), {state: ''});
		const response = await request(`/callback?state=${state}&error=access_denied`, undefined, cookie);
		const location = new URL(response.headers.get('location')!);
		expect(location.searchParams.get('error')).toBe('access_denied');
		expect(location.searchParams.get('state')).toBe('');
		expect(location.searchParams.get('existing')).toBe('1');
		expect(location.searchParams.has('code')).toBe(false);
		expect(location.searchParams.has('error_description')).toBe(false);
		expect(response.headers.get('set-cookie')).toContain('Path=/callback');
		expect(googleFetch).not.toHaveBeenCalled();
	});

	it('omits client state when the authorization query omits it', async () => {
		const clientId = await register();
		const query = new URLSearchParams({
			response_type: 'code', client_id: clientId, redirect_uri: redirectUri,
			code_challenge: challenge, code_challenge_method: 'S256',
		});
		const authorization = await request(`/authorize?${query.toString()}`);
		const state = new URL(authorization.headers.get('location')!).searchParams.get('state')!;
		const response = await request(`/callback?state=${state}&code=google`, undefined, authorization.headers.get('set-cookie')!.split(';')[0]);
		expect(new URL(response.headers.get('location')!).searchParams.has('state')).toBe(false);
	});

	it('exchanges only the stored Google code with server credentials and prevents replay', async () => {
		const clientId = await register();
		const code = await issueCode(clientId);
		const response = await exchange(clientId, code, {client_secret: 'attacker', arbitrary: 'ignored'});
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(await response.json()).toEqual({access_token: 'google-token'});
		const parameters = new URLSearchParams(googleFetch.mock.calls[0]![1]!.body as string);
		expect(Object.fromEntries(parameters)).toEqual({
			grant_type: 'authorization_code', code: 'real-google-code',
			code_verifier: verifier, redirect_uri: `${baseUrl}/callback`, client_id: 'server-client', client_secret: 'server-secret',
		});
		await expectError(await exchange(clientId, code), 'invalid_grant');
		expect(googleFetch).toHaveBeenCalledTimes(1);
	});

	it('rejects wrong verifier, client and redirect without consuming a legitimate local code', async () => {
		const clientId = await register();
		const otherClient = await register();
		const code = await issueCode(clientId);
		await expectError(await exchange(clientId, code, {code_verifier: 'w'.repeat(43)}), 'invalid_grant');
		await expectError(await exchange(otherClient, code), 'invalid_grant');
		await expectError(await exchange(clientId, code, {redirect_uri: `${redirectUri}&changed=1`}), 'invalid_grant');
		await expectError(await exchange('unknown', code), 'invalid_client');
		await expectError(await exchange(clientId, 'unknown'), 'invalid_grant');
		expect(googleFetch).not.toHaveBeenCalled();
		expect((await exchange(clientId, code)).status).toBe(200);
	});

	it('expires local codes at the TTL boundary', async () => {
		const clientId = await register();
		const code = await issueCode(clientId);
		vi.setSystemTime(Date.now() + TTL);
		await expectError(await exchange(clientId, code), 'invalid_grant');
		expect(googleFetch).not.toHaveBeenCalled();
	});

	it.each([{},
		{grant_type: 'authorization_code'},
		{grant_type: 'refresh_token'},
		{
			grant_type: 'authorization_code', client_id: 'unknown', code: 'code', redirect_uri: redirectUri, code_verifier: 'short',
		},
		{grant_type: ['refresh_token']}])('rejects malformed token requests %#', async (body) => {
		const response = await request('/token', body);
		await expectError(response, 'invalid_request');
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(googleFetch).not.toHaveBeenCalled();
	});

	it('rejects unsupported grant types', async () => {
		await expectError(await request('/token', {grant_type: 'password'}), 'unsupported_grant_type');
		expect(googleFetch).not.toHaveBeenCalled();
	});

	it('refreshes only for registered clients and omits redirect and caller-controlled fields', async () => {
		const clientId = await register();
		await expectError(await request('/token', {grant_type: 'refresh_token', client_id: 'unknown', refresh_token: 'refresh'}), 'invalid_client');
		await expectError(await request('/token', {grant_type: 'refresh_token', client_id: clientId, refresh_token: ''}), 'invalid_request');
		expect(googleFetch).not.toHaveBeenCalled();
		const response = await request('/token', {
			grant_type: 'refresh_token', client_id: clientId, refresh_token: 'refresh', redirect_uri: 'attacker', code: 'ignored',
		});
		expect(response.status).toBe(200);
		expect(Object.fromEntries(new URLSearchParams(googleFetch.mock.calls[0]![1]!.body as string))).toEqual({
			grant_type: 'refresh_token', refresh_token: 'refresh', client_id: 'server-client', client_secret: 'server-secret',
		});
	});

	it('forwards upstream status and JSON without logging secrets', async () => {
		googleFetch.mockResolvedValueOnce(new Response(JSON.stringify({error: 'invalid_grant'}), {status: 400}));
		const clientId = await register();
		const code = await issueCode(clientId);
		await expectError(await exchange(clientId, code), 'invalid_grant');
		expect(JSON.stringify(errorLog.mock.calls)).not.toContain('real-google-code');
		expect(JSON.stringify(errorLog.mock.calls)).not.toContain('server-secret');
		expect(JSON.stringify(errorLog.mock.calls)).not.toContain(verifier);
	});

	it('returns secret-free network failures and never retries a consumed code', async () => {
		googleFetch.mockRejectedValueOnce(new Error('server-secret real-google-code'));
		const clientId = await register();
		const code = await issueCode(clientId);
		await expectError(await exchange(clientId, code), 'server_error', 500);
		await expectError(await exchange(clientId, code), 'invalid_grant');
		expect(googleFetch).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(errorLog.mock.calls)).not.toContain('server-secret');
	});
});
