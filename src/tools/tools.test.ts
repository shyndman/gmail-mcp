import {
	describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {createServer} from '../index.js';

const readTools = [
	'get_profile',
	'messages_list',
	'message_get',
	'threads_list',
	'thread_get',
	'drafts_list',
	'draft_get',
	'labels_list',
	'label_get',
	'attachment_get',
	'filters_list',
	'filter_get',
	'vacation_get',
];

const writeTools = [
	'message_send',
	'message_forward',
	'message_modify',
	'message_archive',
	'message_trash',
	'message_untrash',
	'message_delete',
	'messages_batch_modify',
	'messages_batch_delete',
	'thread_modify',
	'thread_trash',
	'thread_untrash',
	'thread_delete',
	'draft_create',
	'draft_update',
	'draft_send',
	'draft_delete',
	'label_create',
	'label_update',
	'label_delete',
	'filter_create',
	'filter_delete',
	'vacation_set',
];

const fetchMock = vi.fn<typeof fetch>();

describe('MCP tool access', () => {
	let server: McpServer | undefined;
	let client: Client | undefined;

	beforeEach(() => {
		fetchMock.mockReset();
		vi.stubGlobal('fetch', fetchMock);
	});

	afterEach(async () => {
		try {
			await client?.close();
		} finally {
			await server?.close();
			client = undefined;
			server = undefined;
			vi.unstubAllGlobals();
		}
	});

	const connect = async (
		destructive: boolean,
		getAccessToken: () => Promise<string> = async () => 'test-token',
	): Promise<Client> => {
		server = createServer({getAccessToken, destructive});
		client = new Client({name: 'tool-access-test', version: '1.0.0'});
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await server.connect(serverTransport);
		await client.connect(clientTransport);
		return client;
	};

	it('exposes exactly the read tools and blocks every write in read-only mode', async () => {
		const connectedClient = await connect(false);
		const {tools} = await connectedClient.listTools();
		expect(tools.map(({name}) => name).sort()).toEqual([...readTools].sort());

		await Promise.all(writeTools.map(async (name) => {
			const result = await connectedClient.callTool({name, arguments: {}});
			expect(result.isError, `${name} must be unavailable`).toBe(true);
			expect(result.content).toEqual(expect.arrayContaining([
				expect.objectContaining({type: 'text', text: expect.stringContaining(`Tool ${name} not found`)}),
			]));
		}));

		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('exposes exactly all 36 tools in destructive mode', async () => {
		const connectedClient = await connect(true);
		const {tools} = await connectedClient.listTools();
		expect(tools.map(({name}) => name).sort()).toEqual([...readTools, ...writeTools].sort());
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('resolves a refreshed token for each get_profile call', async () => {
		const getAccessToken = vi.fn<() => Promise<string>>()
			.mockResolvedValueOnce('initial-token')
			.mockResolvedValueOnce('refreshed-token');
		fetchMock.mockImplementation(async () => new Response(
			JSON.stringify({emailAddress: 'test@example.com', messagesTotal: 2}),
			{headers: {'Content-Type': 'application/json'}},
		));
		const connectedClient = await connect(false, getAccessToken);

		const initialResult = await connectedClient.callTool({name: 'get_profile', arguments: {}});
		expect(initialResult.isError).not.toBe(true);
		expect(initialResult.structuredContent).toEqual({emailAddress: 'test@example.com', messagesTotal: 2});

		const refreshedResult = await connectedClient.callTool({name: 'get_profile', arguments: {}});
		expect(refreshedResult.isError).not.toBe(true);
		expect(refreshedResult.structuredContent).toEqual({emailAddress: 'test@example.com', messagesTotal: 2});

		expect(getAccessToken).toHaveBeenCalledTimes(2);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock.mock.calls.map(([url, options]) => ({
			url,
			method: options?.method,
			authorization: new Headers(options?.headers).get('Authorization'),
		}))).toEqual([
			{url: 'https://gmail.googleapis.com/gmail/v1/users/me/profile', method: 'GET', authorization: 'Bearer initial-token'},
			{url: 'https://gmail.googleapis.com/gmail/v1/users/me/profile', method: 'GET', authorization: 'Bearer refreshed-token'},
		]);
	});
});
