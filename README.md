# gmail-mcp

MCP server for Gmail - read, send, archive, and manage emails.

## Use Cases

**Flight check-in**: "Check me in for my flight tomorrow" → finds your confirmation email, extracts the booking reference, and completes check-in with browser use.

**Expense submission**: "Submit my Amazon purchases from last week as expenses" → finds receipts, extracts amounts/categories, and files them in your expense system.

**Package tracking**: "Where's my package from Acme?" → finds the shipping notification, extracts the tracking number, and fetches current delivery status.

**Find that attachment**: "What did we settle on for the budget? Michelle sent me something yesterday" → locates the email and opens the attached spreadsheet.

**Vacation mode**: "I'm on holiday Dec 20-Jan 2" → sets up Gmail auto-reply, blocks your calendar, and updates your Slack status in one go.

**Meeting follow-up**: After a call, your assistant reads the Gemini transcript, summarizes key decisions, and drafts a follow-up email with action items.

(These are just examples - any workflow that needs email search, reading, or sending can use this.)

## Setup

### 1. Create Google OAuth credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or use existing)
3. Enable the Gmail API
4. Go to **APIs & Services** → **OAuth consent screen**, set up consent screen
5. Go to **APIs & Services** → **Credentials** → **Create Credentials** → **OAuth client ID**
6. Choose **Web application**
7. Add `http://localhost:3000/callback` to **Authorized redirect URIs**
8. Note your Client ID and Client Secret

### 2. Configure a stdio client

Use Node.js 22 or later. Install dependencies with `npm ci`, then build with `npm run build`.
The MCP client starts this server. Supply `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` through its environment.
The server does not load `.env` files itself.

For OMP, put the credentials in `~/.omp/agent/.env`. OMP loads that file and passes its environment to stdio servers.
Add this entry to `~/.omp/agent/mcp.json`, with the absolute path to your checkout:

```json
{
  "mcpServers": {
    "gmail": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/gmail-mcp/dist/main.js"],
      "env": {"MCP_TRANSPORT": "stdio"}
    }
  }
}
```

On first use, the server opens the browser and a temporary OAuth callback listener on `127.0.0.1:3000`.
The callback URL is `http://localhost:3000/callback`. `PORT` changes the callback port and must match the Google registration.
MCP initialization and tool discovery do not wait for login. Until login completes, tool calls return an authorization-pending error.
If the browser does not open, use the authorization URL from the server's stderr output.
The callback listener closes after authorization, failure, or the ten-minute timeout.
If authorization fails, fix the reported cause and restart the server through your MCP client.
Shutdown and the login timeout also abort pending Google token requests.

The server saves only the refresh token under `$XDG_DATA_HOME/gmail-mcp/oauth`, or `~/.local/share/gmail-mcp/oauth` by default.
The directory uses permissions `0700`, and each credential file uses `0600`.
Each Google client and scope set has a separate file. The cache works across projects.
On restart, the server uses the saved refresh token without opening the browser or callback listener.
It refreshes expired access tokens before Gmail requests. A revoked refresh token starts a new browser login.

The server defaults to read-only mode and exposes 13 read tools.
Add `--destructive` to the client's `args` to enable all 36 tools, including every send and write operation.
That mode requests `gmail.readonly`, `gmail.send`, and `gmail.modify`, and has a separate credential cache.

### 3. HTTP transport

HTTP remains available when you manage the server process separately:

```bash
GOOGLE_CLIENT_ID='your-client-id' \
GOOGLE_CLIENT_SECRET='your-client-secret' \
MCP_TRANSPORT=http \
node dist/main.js
```

The HTTP listener binds only to `127.0.0.1`. Its default advertised URL is `http://localhost:3000/mcp`.
`PORT` changes its port. `MCP_BASE_URL` sets the advertised base URL for an HTTPS reverse proxy.
The listener still binds only to loopback.
Add `--destructive` to enable write tools. Disabled tools remain unavailable even with a broad existing token.

## Architecture

With stdio, this server owns browser authorization and refresh credentials. With HTTP, it acts as an OAuth proxy:

```mermaid
graph LR
    A[MCP client] <--> B[gmail-mcp] <--> C[Google OAuth/API]
```

1. The server advertises OAuth metadata at `/.well-known/oauth-authorization-server`.
2. `/register` creates a public client with exact registered callback URLs. It does not expose Google credentials.
3. `/authorize` requires S256 Proof Key for Code Exchange (PKCE) and creates an opaque, browser-bound transaction.
4. `/callback` checks that transaction and issues a one-use local code to the registered callback.
5. `/token` checks the client, callback, and verifier before it exchanges the stored Google code.
6. `/mcp` uses the bearer token to call the Gmail API.

Callback URLs must use HTTPS or loopback HTTP (`localhost`, `127.0.0.1`, or `[::1]`).
Registrations and pending transactions remain in memory. A restart requires registration and authorization again.
Authorization transactions and local codes expire after ten minutes. The client keeps the Google access and refresh tokens.

## Tools

| Tool | Description |
|------|-------------|
| `get_profile` | Get the account email address and profile |
| **Messages** | |
| `messages_list` | Search or list messages |
| `message_get` | Get a message |
| `message_send` | Send an email |
| `message_forward` | Forward an email |
| `message_modify` | Add or remove labels |
| `message_archive` | Remove a message from the inbox |
| `message_trash` | Move a message to trash |
| `message_untrash` | Restore a message from trash |
| `message_delete` | Permanently delete a message |
| `messages_batch_modify` | Change labels on multiple messages |
| `messages_batch_delete` | Permanently delete multiple messages |
| **Threads** | |
| `threads_list` | Search or list threads |
| `thread_get` | Get all messages in a thread |
| `thread_modify` | Add or remove labels |
| `thread_trash` | Move a thread to trash |
| `thread_untrash` | Restore a thread from trash |
| `thread_delete` | Permanently delete a thread |
| **Drafts** | |
| `drafts_list` | List drafts |
| `draft_get` | Get a draft |
| `draft_create` | Create a draft |
| `draft_update` | Change a draft |
| `draft_send` | Send a draft |
| `draft_delete` | Delete a draft |
| **Labels** | |
| `labels_list` | List labels |
| `label_get` | Get a label |
| `label_create` | Create a label |
| `label_update` | Change a label |
| `label_delete` | Delete a label |
| **Attachments** | |
| `attachment_get` | Download an attachment |
| **Filters** | |
| `filters_list` | List filters |
| `filter_get` | Get a filter |
| `filter_create` | Create a filter |
| `filter_delete` | Delete a filter |
| **Settings** | |
| `vacation_get` | Get vacation settings |
| `vacation_set` | Change vacation settings |

Harnesses add tool prefixes. This server does not add them.

## Gmail API Scopes

- Default: `gmail.readonly` for read tools.
- With `--destructive`: `gmail.readonly`, `gmail.send`, and `gmail.modify`.

## Contributing

Pull requests are welcomed on GitHub! To get started:

1. Install Git and Node.js
2. Clone the repository
3. Install dependencies with `npm install`
4. Run `npm run test` to run tests
5. Build with `npm run build`

## Releases

Versions follow the [semantic versioning spec](https://semver.org/).

To release:

1. Use `npm version <major | minor | patch>` to bump the version
2. Run `git push --follow-tags` to push with tags
3. Wait for GitHub Actions to publish to the NPM registry.
