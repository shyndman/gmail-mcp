#!/usr/bin/env node
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
import express, {type Request, type Response} from 'express';
import {createServer} from './index.js';
import {parseArgs} from 'node:util';
import {isTokenValid} from './utils/token-cache.js';
import {registerOAuthRoutes} from './utils/oauth.js';

// Google OAuth configuration - users must provide their own credentials
const {GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET} = process.env;

const READ_ONLY_SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
const DESTRUCTIVE_SCOPES = [
	'https://www.googleapis.com/auth/gmail.readonly',
	'https://www.googleapis.com/auth/gmail.send',
	'https://www.googleapis.com/auth/gmail.modify',
];
const HTTP_LISTEN_HOST = '127.0.0.1';

function setupSignalHandlers(cleanup: () => Promise<void>): void {
	process.on('SIGINT', async () => {
		await cleanup();
		process.exit(0);
	});
	process.on('SIGTERM', async () => {
		await cleanup();
		process.exit(0);
	});
}

function extractBearerToken(req: Request): string | undefined {
	const authHeader = req.headers.authorization;
	if (!authHeader?.startsWith('Bearer ')) {
		return undefined;
	}

	return authHeader.slice(7);
}

const transport = process.env.MCP_TRANSPORT || 'stdio';

(async () => {
	let destructive: boolean;
	try {
		const {values} = parseArgs({
			args: process.argv.slice(2),
			options: {destructive: {type: 'boolean', default: false}},
			strict: true,
			allowPositionals: false,
		});
		destructive = values.destructive;
	} catch (error) {
		console.error('gmail-mcp: Invalid CLI arguments:', (error as Error).message);
		process.exit(1);
	}

	const scopes = destructive ? DESTRUCTIVE_SCOPES : READ_ONLY_SCOPES;
	console.error(destructive ? 'gmail-mcp: destructive mode' : 'gmail-mcp: read-only mode');
	if (transport === 'stdio') {
		const accessToken = process.env.GOOGLE_ACCESS_TOKEN;
		if (!accessToken) {
			console.error('gmail-mcp: GOOGLE_ACCESS_TOKEN required for stdio transport');
			console.error('For OAuth support, use HTTP transport: MCP_TRANSPORT=http');

			process.exit(1);
		}

		const server = createServer({token: accessToken, destructive});
		setupSignalHandlers(async () => server.close());

		const stdioTransport = new StdioServerTransport();
		await server.connect(stdioTransport);
		console.error('Gmail MCP server running on stdio');
	} else if (transport === 'http') {
		if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
			console.error('gmail-mcp: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET required for HTTP transport');

			process.exit(1);
		}

		const app = express();
		app.use(express.json({limit: '20mb'}));
		app.use(express.urlencoded({extended: true}));

		const port = parseInt(process.env.PORT || '3000', 10);
		const baseUrl = process.env.MCP_BASE_URL || `http://localhost:${port}`;

		registerOAuthRoutes(app, {
			baseUrl,
			googleClientId: GOOGLE_CLIENT_ID,
			googleClientSecret: GOOGLE_CLIENT_SECRET,
			scopes,
		});

		// Stateless MCP endpoint
		app.post('/mcp', async (req: Request, res: Response) => {
			const token = extractBearerToken(req);

			// Require auth, except for tools/list for discovery
			const method = req.body?.method as string | undefined;
			if (!token && method !== 'tools/list') {
				res.status(401).json({
					jsonrpc: '2.0',
					error: {code: -32001, message: 'Unauthorized: Bearer token required'},
					id: null,
				});
				return;
			}

			// Validate token before processing
			if (token && !await isTokenValid(token)) {
				res.status(401).json({
					jsonrpc: '2.0',
					error: {code: -32001, message: 'Unauthorized: Invalid or expired token'},
					id: null,
				});
				return;
			}

			const server = createServer({token: token ?? '', destructive});

			try {
				const httpTransport = new StreamableHTTPServerTransport({
					enableJsonResponse: true,
				});
				// The SDK declares this class as Transport but widens its optional callback getters.
				await server.connect(httpTransport as Transport);

				await httpTransport.handleRequest(req, res, req.body);

				res.on('close', () => {
					void httpTransport.close();
					void server.close();
				});
			} catch (error) {
				console.error('Error handling MCP request:', error);
				if (!res.headersSent) {
					res.status(500).json({
						jsonrpc: '2.0',
						error: {code: -32603, message: 'Internal server error'},
						id: null,
					});
				}
			}
		});

		const httpServer = app.listen(port, HTTP_LISTEN_HOST, () => {
			console.error(`Gmail MCP server running on ${baseUrl}/mcp`);
		});

		httpServer.on('error', (err: NodeJS.ErrnoException) => {
			console.error('FATAL: Server error', err.message);
			process.exit(1);
		});

		setupSignalHandlers(async () => {
			httpServer.close();
		});
	} else {
		console.error(`Unknown transport: ${transport}. Use MCP_TRANSPORT=stdio or MCP_TRANSPORT=http`);

		process.exit(1);
	}
})();
