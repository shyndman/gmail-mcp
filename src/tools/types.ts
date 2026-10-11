export type Config = {
	/** Resolve the current Google OAuth access token before each request. */
	getAccessToken: () => Promise<string>;
	/** Enable tools that change Gmail data or send email. */
	destructive: boolean;
};
