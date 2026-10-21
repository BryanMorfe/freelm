import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { BotConversation, BotMessage, BotProfile, BotProfileInput } from '../../bot-types';
import type { Connection } from '../../types';
import BotsWorkspace from '../../components/BotsWorkspace';
import BotsSidebar from '../../components/BotsSidebar';
import { BotProfileDialog, BotGroupDialog } from '../../components/BotDialogs';
import type { BotContact } from '../../components/bots-ui-types';
import { resolveBotMentions } from '../../lib/bot-mentions';

const now = Date.now();
const connection: Connection = {
	id: 'preview',
	name: 'Local model',
	baseUrl: 'http://localhost:8090/v1',
	apiKey: '',
	chatApi: 'responses',
	models: { chat: 'qwen', images: '', videos: '', speech: '', transcription: '' },
	discoveredModels: ['qwen'],
	catalog: [
		{
			id: 'qwen',
			name: 'Qwen 3.8 27B',
			enabled: true,
			tasks: ['chat'],
			inputModalities: ['text'],
			outputModalities: ['text'],
			thinkingModes: [
				{
					id: 'medium',
					name: 'Medium',
					parameters: { responses: { reasoning: { effort: 'medium' } } },
				},
			],
			defaultThinkingMode: 'medium',
		},
	],
};
const bot = (id: string, name: string, color: string): BotProfile => ({
	id,
	name,
	address: `${name.toLowerCase()}@freelm`,
	color,
	identity:
		'Curious and thoughtful. Help me find useful connections and keep our conversations warm and direct.',
	learnedPersonality: 'You prefer clear explanations and small, practical next steps.',
	enabled: true,
	historyAccess: true,
	personalityLearning: true,
	memoryEnabled: true,
	memories: [
		{
			id: `${id}-research-memory`,
			key: 'research-benchmark',
			kind: 'decision',
			content:
				'The research group will compare a small local model with the larger baseline using the same prompts.',
			source: {
				hostId: 'mac',
				conversationId: 'research-team',
				title: 'Research team',
				messageIds: ['research-decision'],
				group: true,
			},
			createdAt: now - 60_000,
			updatedAt: now - 60_000,
		},
	],
	connectionId: 'preview',
	model: 'qwen',
	thinkingMode: 'medium',
	createdAt: now - 86_400_000,
	updatedAt: now,
});
const contacts: BotContact[] = [
	{ bot: bot('fred', 'Fred', '#3c8c74'), host: { id: 'mac', name: 'This Mac' } },
	{ bot: bot('nova', 'Nova', '#8762bd'), host: { id: 'linux', name: 'Studio Linux' } },
];
const message = (
	id: string,
	role: 'user' | 'bot',
	content: string,
	minute: number,
	author = 'fred',
): BotMessage => ({
	id,
	role,
	content,
	createdAt: now - minute * 60_000,
	updatedAt: now - minute * 60_000,
	status: 'completed',
	reactions: [],
	...(role === 'bot'
		? { author: { hostId: author === 'fred' ? 'mac' : 'linux', botId: author } }
		: {}),
});
const base: BotConversation = {
	id: 'direct',
	title: 'Fred',
	participants: [{ hostId: 'mac', botId: 'fred' }],
	draft: '',
	createdAt: now - 86_400_000,
	updatedAt: now,
	readAt: now,
	messages: [
		message('one', 'user', 'Hey Fred, I finally finished the first version of Mosaic.', 30),
		message(
			'two',
			'bot',
			'That’s a good milestone. How does it feel to use it now that the pieces are together?',
			29,
		),
		message(
			'three',
			'user',
			'It feels surprisingly good. I want to keep improving the little details without getting lost in them.',
			4,
		),
		message(
			'four',
			'bot',
			'Pick one flow you use every day and make it feel effortless. You’ll notice that improvement more than ten things you only see once.',
			3,
		),
		message('five', 'bot', 'What’s the part that still interrupts your rhythm?', 3),
	],
};
const longReply = `The gallery review is complete. The everyday flow is working well, and there are a few details worth keeping in the record.

### What I checked

- Creating a note and reopening it after restarting the app.
- Importing a picture and keeping its original proportions.
- Searching titles and finding the right result.
- Moving a note between collections without losing its attachments.
- Navigating with the keyboard and returning focus to the composer.

### Results

| Flow | Result |
| --- | --- |
| Create and edit | Passed |
| Import a picture | Passed |
| Search and organize | Passed |
| Keyboard navigation | Passed |

The next useful improvement is a small one: keep the gallery position when you return from a note. That makes it easier to compare a few nearby items without finding your place again.

~~~ts
const returnToGallery = () => {
  restoreScrollPosition();
  focusPreviousNote();
};
~~~

That is the complete review. Nothing in this preview sends a request to a model or changes a saved conversation.`;
function Gallery({
	state = 'direct',
	narrow = false,
}: {
	state?:
		| 'direct'
		| 'empty'
		| 'typing'
		| 'thinking'
		| 'activity'
		| 'group-activity'
		| 'group-mentions'
		| 'group-paused'
		| 'group-running'
		| 'failed'
		| 'group'
		| 'reactions'
		| 'receipts'
		| 'long'
		| 'create'
		| 'profile'
		| 'new-group';
	narrow?: boolean;
}) {
	const [directory, setDirectory] = useState(() =>
		state === 'group-mentions'
			? [
					...contacts,
					{ bot: bot('alex-mac', 'Alex Morgan', '#b37a48'), host: { id: 'mac', name: 'This Mac' } },
					{
						bot: bot('alex-linux', 'Alex Morgan', '#728bc7'),
						host: { id: 'linux', name: 'Studio Linux' },
					},
				]
			: contacts,
	);
	const [conversation, setConversation] = useState<BotConversation | undefined>(() => {
		if (state === 'empty') return undefined;
		const value = structuredClone(base);
		if (state.startsWith('group')) {
			value.id = 'group';
			value.title = 'The brainstorm room';
			value.participants.push({ hostId: 'linux', botId: 'nova' });
			value.messages.push(
				message(
					'six',
					'bot',
					'I can help look at the visual side while Fred looks at the interaction. Let’s start with that one flow.',
					2,
					'nova',
				),
			);
		}
		if (state === 'group-mentions') {
			value.participants = directory.map(({ bot, host }) => ({ botId: bot.id, hostId: host.id }));
			const roster = directory.map(({ bot, host }) => ({
				botId: bot.id,
				hostId: host.id,
				name: bot.name,
				address: bot.address,
			}));
			const user = message(
				'mention-request',
				'user',
				'✨ @Nova, could you review the layout with @Fred? Keep `@Fred` and [@Nova](https://example.com) as examples.',
				1,
			);
			const response = message(
				'mention-reply',
				'bot',
				'I can review the layout. @Nova, would you take a look at the colors?',
				1,
			);
			value.messages = [user, response].map((item) => ({
				...item,
				mentions: resolveBotMentions(item.content, roster),
			}));
		}
		if (state === 'group-paused') {
			value.groupReplyLimit = 12;
			value.groupReplyState = { rootMessageId: 'three', automaticReplies: 12, paused: 'limit' };
		}
		if (state === 'group-running') {
			value.groupReplyState = { rootMessageId: 'three', automaticReplies: 3 };
			value.messages.push({
				...message('working', 'bot', '', 0),
				status: 'pending',
				activity: 'thinking',
			});
		}
		if (state === 'typing')
			value.messages.push({
				...message('six', 'bot', '', 0),
				status: 'pending',
				activity: 'writing',
			});
		if (state === 'thinking' || state === 'activity' || state === 'group-activity')
			value.messages.push({
				...message('activity', 'bot', '', 0),
				status: 'pending',
				activity: 'thinking',
			});
		if (state === 'group-activity')
			value.messages.push({
				...message('nova-writing', 'bot', '', 0, 'nova'),
				status: 'pending',
				activity: 'writing',
			});
		if (state === 'failed')
			value.messages.push({
				...message('six', 'bot', '', 0),
				status: 'failed',
				error: 'The host could not reach the model. Check the connection and try again.',
			});
		if (state === 'reactions') {
			value.messages[3].reactions = [{ actorId: 'user', emoji: '❤️', createdAt: now }];
			value.messages[2].reactions = [{ actorId: 'bot:mac:fred', emoji: '👍', createdAt: now }];
		}
		if (state === 'receipts') {
			value.messages = [
				{
					...message('read', 'user', 'Did you get a chance to look at Mosaic?', 4),
					readBy: [{ hostId: 'mac', botId: 'fred', readAt: now - 3 * 60_000 }],
				},
				message('reply', 'bot', 'Yep! The new layout is much easier to follow.', 3),
				{
					...message('edited', 'user', 'Can you check the gallery too?', 1),
					editedAt: now - 30_000,
				},
			];
		}
		if (state === 'long') {
			value.messages = [
				message('review-request', 'user', 'How did the gallery review go?', 4),
				message('long-reply', 'bot', longReply, 3),
			];
		}
		return value;
	});
	const [dialog, setDialog] = useState<'create' | 'profile' | 'new-group' | undefined>(
		['create', 'profile', 'new-group'].includes(state)
			? (state as 'create' | 'profile' | 'new-group')
			: undefined,
	);
	function update(id: string, change: (message: BotMessage) => BotMessage) {
		setConversation(
			(current) =>
				current && {
					...current,
					messages: current.messages.map((item) => (item.id === id ? change(item) : item)),
				},
		);
	}
	function save(profile: BotProfileInput) {
		setDirectory((value) =>
			dialog === 'profile'
				? value.map((item, index) =>
						index === 0 ? { ...item, bot: { ...item.bot, ...profile } } : item,
					)
				: [
						...value,
						{
							bot: {
								...bot(crypto.randomUUID(), profile.name, profile.color || '#3c8c74'),
								...profile,
							},
							host: { id: 'mac', name: 'This Mac' },
						},
					],
		);
	}
	return (
		<>
			{state === 'long' && (
				<div style={{ marginBottom: 12 }}>
					<button
						className="secondary-button"
						onClick={() =>
							setConversation(
								(value) =>
									value && {
										...value,
										messages: [
											...value.messages,
											message(crypto.randomUUID(), 'bot', longReply, 0),
										],
									},
							)
						}
					>
						Receive a reply
					</button>
				</div>
			)}
			{state === 'activity' && (
				<div
					style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}
					aria-label="Preview bot activity"
				>
					{(['queued', 'thinking', 'writing', 'completed', 'failed'] as const).map((phase) => (
						<button
							key={phase}
							className="secondary-button"
							onClick={() =>
								update('activity', (value) => ({
									...value,
									status: phase === 'completed' || phase === 'failed' ? phase : 'pending',
									activity: phase === 'completed' || phase === 'failed' ? undefined : phase,
									content:
										phase === 'completed'
											? 'I found a simpler way to organize it. Want to try it together?'
											: '',
									error: phase === 'failed' ? 'The model connection was interrupted.' : undefined,
								}))
							}
						>
							{phase[0].toUpperCase() + phase.slice(1)}
						</button>
					))}
				</div>
			)}
			<div
				style={{
					width: narrow ? 390 : '100%',
					maxWidth: 'min(1200px, 100%)',
					height: 760,
					display: 'flex',
					background: 'var(--bg)',
					borderRadius: 14,
					overflow: 'hidden',
					border: '1px solid var(--border)',
				}}
			>
				{!narrow && (
					<div style={{ width: 265, display: 'flex', flexShrink: 0 }}>
						<BotsSidebar
							contacts={directory}
							conversations={conversation ? [conversation] : []}
							selectedConversationId={conversation?.id}
							hostName="This Mac"
							onSelectConversation={() => {}}
							onSelectBot={(contact) =>
								setConversation({
									...structuredClone(base),
									participants: [{ hostId: contact.host.id, botId: contact.bot.id }],
									title: contact.bot.name,
								})
							}
							onCreateBot={() => setDialog('create')}
							onNewGroup={() => setDialog('new-group')}
						/>
					</div>
				)}
				<div style={{ minWidth: 0, flex: 1 }}>
					<BotsWorkspace
						conversation={conversation}
						contacts={directory}
						hostName="This Mac"
						onDraftChange={(draft, draftMentions) =>
							setConversation((value) => value && { ...value, draft, draftMentions })
						}
						onStop={() =>
							setConversation(
								(value) =>
									value && {
										...value,
										groupReplyState: {
											rootMessageId: 'three',
											automaticReplies: value.groupReplyState?.automaticReplies || 0,
											paused: 'stopped',
										},
										messages: value.messages.map((item) =>
											item.status === 'pending'
												? { ...item, status: 'completed', activity: undefined }
												: item,
										),
									},
							)
						}
						onGroupReplyLimitChange={(groupReplyLimit) =>
							setConversation((value) => value && { ...value, groupReplyLimit })
						}
						onSend={(content, replyTo, mentions) =>
							setConversation(
								(value) =>
									value && {
										...value,
										draft: '',
										draftMentions: [],
										groupReplyState: undefined,
										messages: [
											...value.messages,
											{ ...message(crypto.randomUUID(), 'user', content, 0), replyTo, mentions },
										],
									},
							)
						}
						onReact={(item, emoji) =>
							update(item.id, (value) => ({
								...value,
								reactions: [
									...value.reactions.filter((reaction) => reaction.actorId !== 'user'),
									...(emoji ? [{ actorId: 'user', emoji, createdAt: Date.now() }] : []),
								],
							}))
						}
						onEdit={(item, content, mentions) =>
							update(item.id, (value) => ({ ...value, content, mentions, editedAt: Date.now() }))
						}
						onUnsend={(item) =>
							update(item.id, (value) => ({
								...value,
								status: 'unsent',
								content: '',
								reactions: [],
								unsentAt: Date.now(),
							}))
						}
						onRetry={(item) =>
							update(item.id, (value) => ({
								...value,
								content: 'The retry is complete in this local preview.',
								error: undefined,
								status: 'completed',
							}))
						}
						onCreateBot={() => setDialog('create')}
						onNewGroup={() => setDialog('new-group')}
						onEditBot={() => setDialog('profile')}
					/>
				</div>
				{(dialog === 'create' || dialog === 'profile') && (
					<BotProfileDialog
						profile={dialog === 'profile' ? directory[0].bot : undefined}
						hosts={[{ targetId: 'local', name: 'This Mac', connections: [connection] }]}
						hostId="local"
						onSave={save}
						onUpdateMemory={(memoryId, content) =>
							setDirectory((items) =>
								items.map((item, index) =>
									index === 0
										? {
												...item,
												bot: {
													...item.bot,
													memories: item.bot.memories?.map((memory) =>
														memory.id === memoryId
															? { ...memory, content, updatedAt: Date.now() }
															: memory,
													),
												},
											}
										: item,
								),
							)
						}
						onDeleteMemory={(memoryId) =>
							setDirectory((items) =>
								items.map((item, index) =>
									index === 0
										? {
												...item,
												bot: {
													...item.bot,
													memories: item.bot.memories?.filter((memory) => memory.id !== memoryId),
												},
											}
										: item,
								),
							)
						}
						onClose={() => setDialog(undefined)}
					/>
				)}
				{dialog === 'new-group' && (
					<BotGroupDialog
						contacts={directory}
						hosts={[
							{ value: 'local', label: 'This Mac' },
							{ value: 'remote', label: 'Studio Linux' },
						]}
						hostId="local"
						onCreate={(participants, title) =>
							setConversation({
								...structuredClone(base),
								id: 'new-group',
								participants,
								title: title || 'New group',
								messages: [],
							})
						}
						onClose={() => setDialog(undefined)}
					/>
				)}
			</div>
		</>
	);
}
const meta = {
	title: 'Bots/Messages',
	component: Gallery,
	tags: ['!autodocs'],
	parameters: {
		layout: 'padded',
		docs: {
			description: {
				component:
					'Actual Bots UI with in-memory sample conversations. Sending, edits, reactions, groups, and profiles only change this preview; no provider, host, or saved profile is used. Edit src/components/BotsWorkspace.tsx, BotsSidebar.tsx, BotDialogs.tsx, or bots.css for live changes.',
			},
		},
	},
} satisfies Meta<typeof Gallery>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Direct: Story = {};
export const Empty: Story = { args: { state: 'empty' } };
export const Typing: Story = { args: { state: 'typing' } };
export const Thinking: Story = { args: { state: 'thinking' } };
export const ActivityTransitions: Story = { args: { state: 'activity' } };
export const GroupActivity: Story = { args: { state: 'group-activity' } };
export const NarrowThinking: Story = { args: { narrow: true, state: 'thinking' } };
export const LongReply: Story = { args: { state: 'long' } };
export const NarrowLongReply: Story = { args: { narrow: true, state: 'long' } };
export const Failed: Story = { args: { state: 'failed' } };
export const Reactions: Story = { args: { state: 'reactions' } };
export const DeliveryAndReadReceipts: Story = { args: { state: 'receipts' } };
export const Group: Story = { args: { state: 'group' } };
export const Narrow: Story = { args: { narrow: true, state: 'reactions' } };
export const CreateBot: Story = { args: { state: 'create' } };
export const CustomizeBot: Story = { args: { state: 'profile' } };
export const NewGroup: Story = { args: { state: 'new-group' } };

export const GroupMentions: Story = { args: { state: 'group-mentions' } };
export const GroupPaused: Story = { args: { state: 'group-paused' } };
export const GroupRunning: Story = { args: { state: 'group-running' } };
export const NarrowGroupRunning: Story = { args: { state: 'group-running', narrow: true } };
