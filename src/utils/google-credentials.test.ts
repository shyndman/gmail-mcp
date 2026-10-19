import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
	afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';
import {createGoogleCredentialsLoader} from './google-credentials.js';

describe('lazy Google credentials', () => {
	let directory: string;
	let path: string;
	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), 'gmail-dotenv-'));
		path = join(directory, '.env');
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		await rm(directory, {recursive: true, force: true});
	});

	it('reads at first use and keeps the result after the file changes', async () => {
		const load = createGoogleCredentialsLoader(path, {});
		await writeFile(path, 'GOOGLE_CLIENT_ID="first-client"\nGOOGLE_CLIENT_SECRET="$(not-a-shell-command)"\n');
		expect(load()).toEqual({clientId: 'first-client', clientSecret: '$(not-a-shell-command)'});
		await writeFile(path, 'GOOGLE_CLIENT_ID=second-client\nGOOGLE_CLIENT_SECRET=second-secret\n');
		expect(load()).toEqual({clientId: 'first-client', clientSecret: '$(not-a-shell-command)'});
	});

	it('keeps inherited values and supplies missing values from dotenv', async () => {
		await writeFile(path, 'GOOGLE_CLIENT_ID=file-client\nGOOGLE_CLIENT_SECRET=file-secret\n');
		const load = createGoogleCredentialsLoader(path, {GOOGLE_CLIENT_ID: 'inherited-client'});
		expect(load()).toEqual({clientId: 'inherited-client', clientSecret: 'file-secret'});
	});

	it('uses inherited credentials when there is no dotenv file', () => {
		const load = createGoogleCredentialsLoader(path, {GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret'});
		expect(load()).toEqual({clientId: 'client', clientSecret: 'secret'});
	});

	it('reports missing credentials at first use and does not reread after failure', async () => {
		const logs = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const load = createGoogleCredentialsLoader(path, {});
		expect(load).toThrow('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required');
		await writeFile(path, 'GOOGLE_CLIENT_ID=client\nGOOGLE_CLIENT_SECRET=secret\n');
		expect(load).toThrow('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required');
		expect(logs).toHaveBeenCalledTimes(1);
	});
});
