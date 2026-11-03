import type { Attachment, Connection } from './types';

/** Addresses are unique within their owning host, never global network identities. */
export interface BotParticipant {
	hostId: string;
	botId: string;
}
/** A resolved @label, using UTF-16 offsets into the original message text. */
export interface BotMention extends BotParticipant {
	start: number;
	end: number;
	label: string;
}
export interface BotGroupContext {
	participants: (BotParticipant & { name: string; address: string })[];
	/** Conversation owner and revision used to retain this bot's shared group experience. */
	source?: { hostId: string; title: string; updatedAt: number };
}
/** Durable knowledge learned by one bot, with the conversation evidence that supports it. */
export interface BotMemory {
	id: string;
	key: string;
	content: string;
	kind: 'fact' | 'decision' | 'preference' | 'relationship' | 'task' | 'lesson';
	source: {
		hostId: string;
		conversationId: string;
		title: string;
		messageIds: string[];
		group: boolean;
	};
	createdAt: number;
	updatedAt: number;
}
export interface BotProfile {
	id: string;
	name: string;
	address: string;
	color: string;
	identity: string;
	learnedPersonality: string;
	enabled: boolean;
	historyAccess: boolean;
	/** Enables learned personality notes. Message reactions remain independently available. */
	personalityLearning: boolean;
	/** Defaults to true for existing bots. Independent of personality learning. */
	memoryEnabled?: boolean;
	memories?: BotMemory[];
	memoryError?: string;
	connectionId: string;
	model: string;
	thinkingMode?: string;
	createdAt: number;
	updatedAt: number;
}
export type BotReactionEmoji = '❤️' | '👍' | '👎' | '😂' | '‼️' | '❓';
export interface BotReaction {
	actorId: string;
	emoji: BotReactionEmoji;
	createdAt: number;
}
export type BotReplyActivity = 'queued' | 'thinking' | 'writing';
export interface BotJobView {
	userMessageId?: string;
	id: string;
	botId: string;
	conversationId: string;
	sourceHostId: string;
	toolName: string;
	title: string;
	status:
		| 'pending'
		| 'running'
		| 'awaiting_approval'
		| 'succeeded'
		| 'failed'
		| 'outcome_unknown'
		| 'cancelled';
	args?: Record<string, unknown>;
	error?: string;
	createdAt: number;
	updatedAt: number;
}
export interface BotSentMessage {
	attachments?: Attachment[];
	id: string;
	content: string;
	createdAt: number;
}
export interface BotMessage {
	attachments?: Attachment[];
	id: string;
	role: 'user' | 'bot';
	author?: BotParticipant;
	content: string;
	mentions?: BotMention[];
	createdAt: number;
	updatedAt: number;
	status: 'pending' | 'completed' | 'failed' | 'unsent';
	/** Live provider activity; absent once the reply reaches a terminal state. */
	activity?: BotReplyActivity;
	reactions: BotReaction[];
	editedAt?: number;
	unsentAt?: number;
	error?: string;
	/** Exchange root that caused this reply; a human message or explicit bot outreach root. */
	replyTo?: string;
	/** Receipt from each bot that actually consumed this revision of the message. */
	readBy?: (BotParticipant & { readAt: number })[];
	/** Host event that caused a proactive reply; never a new user instruction. */
	notification?: BotNotification;
	/** Host-authored group exchange root; never imports a private conversation's authority. */
	groupOutreach?: true;
}
export type BotNotification =
	| { id: string; type: 'job'; jobId: string; status: string; summary: string }
	| {
			id: string;
			type: 'group_message';
			/** The peer message to consider; userMessageId remains the exchange root. */
			messageId: string;
			/** Preserve reaction or bot-outreach restrictions across subsequent peer replies. */
			readOnly?: true;
	  }
	| {
			id: string;
			type: 'reaction';
			messageId: string;
			emoji: BotReactionEmoji | null;
			previousEmoji?: BotReactionEmoji;
	  }
	| {
			id: string;
			type: 'thread';
			hostId: string;
			threadId: string;
			cursor: string;
			status: string;
			title: string;
			summary: string;
	  }
	| {
			id: string;
			type: 'scheduled';
			occurrenceId: string;
			kind: 'reminder' | 'work';
			/** The saved request for this occurrence, not a new human message. */
			prompt: string;
			triggeredAt: number;
	  };
export interface BotTaskWatchReference {
	hostId: string;
	threadId: string;
	afterCursor?: string;
}
export interface BotConversation {
	id: string;
	title: string;
	participants: BotParticipant[];
	messages: BotMessage[];
	draft: string;
	draftMentions?: BotMention[];
	/** Number of automatic peer-triggered evaluations allowed after each human message. */
	groupReplyLimit?: number;
	groupReplyState?: {
		rootMessageId: string;
		automaticReplies: number;
		paused?: 'limit' | 'stopped';
	};
	createdAt: number;
	updatedAt: number;
	readAt: number;
}
export interface BotHostIdentity {
	id: string;
	name: string;
}
export interface BotSnapshot {
	host: BotHostIdentity;
	revision: number;
	/** Client projection of the remote host capability; absent on native snapshots. */
	memorySupported?: boolean;
	runtimeSupported?: boolean;
	jobs?: BotJobView[];
	bots: BotProfile[];
	conversations: BotConversation[];
	/** Configuration choices with API keys removed. Execution stays on this host. */
	connections: Connection[];
}
export type BotProfileInput = Pick<BotProfile, 'name' | 'identity' | 'connectionId' | 'model'> &
	Partial<
		Pick<
			BotProfile,
			| 'address'
			| 'color'
			| 'learnedPersonality'
			| 'enabled'
			| 'historyAccess'
			| 'personalityLearning'
			| 'memoryEnabled'
			| 'thinkingMode'
		>
	>;
export type BotCommand =
	| { type: 'create-bot'; id?: string; profile: BotProfileInput }
	| { type: 'update-bot'; botId: string; changes: Partial<BotProfileInput> }
	| { type: 'delete-bot'; botId: string }
	| { type: 'update-memory'; botId: string; memoryId: string; content: string }
	| { type: 'delete-memory'; botId: string; memoryId: string }
	| { type: 'create-conversation'; id?: string; participants: BotParticipant[]; title?: string }
	| {
			type: 'update-conversation';
			conversationId: string;
			title?: string;
			draft?: string;
			draftMentions?: BotMention[];
			groupReplyLimit?: number;
			readAt?: number;
	  }
	| { type: 'delete-conversation'; conversationId: string }
	| {
			type: 'send';
			attachments?: Attachment[];
			conversationId: string;
			messageId: string;
			content: string;
			replyTo?: string;
			mentions?: BotMention[];
	  }
	| { type: 'stop'; conversationId: string }
	| { type: 'job-approve'; conversationId: string; jobId: string }
	| { type: 'job-deny'; conversationId: string; jobId: string }
	| { type: 'job-cancel'; conversationId: string; jobId: string }
	| {
			type: 'edit';
			conversationId: string;
			messageId: string;
			content: string;
			mentions?: BotMention[];
			expectedUpdatedAt?: number;
	  }
	| { type: 'unsend'; conversationId: string; messageId: string; expectedUpdatedAt?: number }
	| { type: 'react'; conversationId: string; messageId: string; emoji: BotReactionEmoji | null }
	| { type: 'retry'; conversationId: string; messageId: string };
export interface BotCommandResult {
	snapshot: BotSnapshot;
	botId?: string;
	conversationId?: string;
	messageId?: string;
}
/** Authenticated host-to-host delivery; the executing host supplies the author and operation ID. */
export interface BotGroupSendRequest {
	operationId: string;
	author: BotParticipant;
	conversationId: string;
	text: string;
}
/** Confirms durable delivery to the group, not completion of any peer reply. */
export interface BotGroupSendResult {
	hostId: string;
	conversationId: string;
	messageId: string;
	createdAt: number;
	deduplicated: boolean;
}
/** Internal authenticated host-to-host reply contract; no credentials or workspace snapshots. */
export interface BotReplyRequest {
	/** Source mailbox identity; supplied by the coordinating host, not a model argument. */
	source?: { hostId: string; title: string; updatedAt: number };
	botId: string;
	conversationId: string;
	/** Human root, or an explicit bot outreach root for restricted group notifications only. */
	userMessageId: string;
	messages: BotMessage[];
	notification?: BotNotification;
	/** Canonical group roster supplied by the coordinating host. */
	group?: BotGroupContext;
}
export interface BotReplyResult {
	content: string;
	reactions: { messageId: string; emoji: BotReactionEmoji }[];
	/** Empty event acknowledgments need not add another bubble. */
	silent?: boolean;
	readAt?: number;
	taskWatches?: BotTaskWatchReference[];
	/** Durable explicit texts; also streamed immediately by compatible hosts. */
	messages?: BotSentMessage[];
	backgroundWork?: true;
}
/** Native facade can route these calls to any authenticated connected FreeLM host. */
export interface BotBridge {
	onBotsChanged?(listener: () => void): () => void;
	botsSnapshot?(targetId: string): Promise<BotSnapshot>;
	botsCommand?(targetId: string, command: BotCommand): Promise<BotCommandResult>;
}
