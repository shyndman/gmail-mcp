import {config} from 'dotenv';

export type GoogleCredentials = {
	clientId: string;
	clientSecret: string;
};

export function createGoogleCredentialsLoader(path: string, environment: NodeJS.ProcessEnv): () => GoogleCredentials {
	let result: GoogleCredentials | Error | undefined;
	return () => {
		if (result === undefined) {
			const {error} = config({path, processEnv: environment, quiet: true});
			const {GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret} = environment;
			if (error && error.code !== 'ENOENT') {
				result = new Error('Cannot read the project .env file. Check its permissions and restart the server.');
			} else if (!clientId || !clientSecret) {
				result = new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required. Set them in the project .env file or environment and restart the server.');
			} else {
				result = {clientId, clientSecret};
			}

			if (result instanceof Error) {
				console.error(`gmail-mcp: ${result.message}`);
			}
		}

		if (result instanceof Error) {
			throw result;
		}

		return result;
	};
}
