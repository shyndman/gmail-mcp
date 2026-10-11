import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {Config} from './types.js';

// Profile
import {registerProfileGet} from './profile-get.js';

// Messages
import {registerMessagesList} from './messages-list.js';
import {registerMessageGet} from './message-get.js';
import {registerMessageSend} from './message-send.js';
import {registerMessageForward} from './message-forward.js';
import {registerMessageModify} from './message-modify.js';
import {registerMessageArchive} from './message-archive.js';
import {registerMessageTrash} from './message-trash.js';
import {registerMessageUntrash} from './message-untrash.js';
import {registerMessageDelete} from './message-delete.js';
import {registerMessagesBatchModify} from './messages-batch-modify.js';
import {registerMessagesBatchDelete} from './messages-batch-delete.js';

// Threads
import {registerThreadGet} from './thread-get.js';
import {registerThreadsList} from './threads-list.js';
import {registerThreadModify} from './thread-modify.js';
import {registerThreadTrash} from './thread-trash.js';
import {registerThreadUntrash} from './thread-untrash.js';
import {registerThreadDelete} from './thread-delete.js';

// Drafts
import {registerDraftCreate} from './draft-create.js';
import {registerDraftGet} from './draft-get.js';
import {registerDraftsList} from './drafts-list.js';
import {registerDraftUpdate} from './draft-update.js';
import {registerDraftDelete} from './draft-delete.js';
import {registerDraftSend} from './draft-send.js';

// Labels
import {registerLabelsList} from './labels-list.js';
import {registerLabelGet} from './label-get.js';
import {registerLabelCreate} from './label-create.js';
import {registerLabelUpdate} from './label-update.js';
import {registerLabelDelete} from './label-delete.js';

// Attachments
import {registerAttachmentGet} from './attachment-get.js';

// Filters
import {registerFiltersList} from './filters-list.js';
import {registerFilterGet} from './filter-get.js';
import {registerFilterCreate} from './filter-create.js';
import {registerFilterDelete} from './filter-delete.js';

// Vacation
import {registerVacationGet} from './vacation-get.js';
import {registerVacationSet} from './vacation-set.js';

export type {Config} from './types.js';

export function registerAll(server: McpServer, config: Config): void {
	registerProfileGet(server, config);
	registerMessagesList(server, config);
	registerMessageGet(server, config);
	registerThreadsList(server, config);
	registerThreadGet(server, config);
	registerDraftsList(server, config);
	registerDraftGet(server, config);
	registerLabelsList(server, config);
	registerLabelGet(server, config);
	registerAttachmentGet(server, config);
	registerFiltersList(server, config);
	registerFilterGet(server, config);
	registerVacationGet(server, config);

	if (!config.destructive) {
		return;
	}

	registerMessageSend(server, config);
	registerMessageForward(server, config);
	registerMessageModify(server, config);
	registerMessageArchive(server, config);
	registerMessageTrash(server, config);
	registerMessageUntrash(server, config);
	registerMessageDelete(server, config);
	registerMessagesBatchModify(server, config);
	registerMessagesBatchDelete(server, config);
	registerThreadModify(server, config);
	registerThreadTrash(server, config);
	registerThreadUntrash(server, config);
	registerThreadDelete(server, config);
	registerDraftCreate(server, config);
	registerDraftUpdate(server, config);
	registerDraftSend(server, config);
	registerDraftDelete(server, config);
	registerLabelCreate(server, config);
	registerLabelUpdate(server, config);
	registerLabelDelete(server, config);
	registerFilterCreate(server, config);
	registerFilterDelete(server, config);
	registerVacationSet(server, config);
}
