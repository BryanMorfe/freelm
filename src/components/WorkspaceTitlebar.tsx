import {
	Download,
	Folder,
	MessageCircle,
	PanelLeft,
	PanelLeftClose,
	Search,
	SquarePen,
} from 'lucide-react';
import type { Connection, ConversationKind, Thread } from '../types';
import { downloadText } from '../lib/state';
import Select from './Select';

interface Props {
	title: string;
	thread?: Thread;
	projectName?: string;
	kind: ConversationKind;
	conversation: boolean;
	settingsOpen?: boolean;
	panelOpen: boolean;
	workspaceTabsOpen?: boolean;
	workspaceTabCount?: number;
	onToggleWorkspaceTabs?: () => void;
	pinnedSummaryAvailable?: boolean;
	pinnedSummaryOpen?: boolean;
	busy: boolean;
	connection: Connection;
	connections: Connection[];
	onTogglePanel: () => void;
	onTogglePinnedSummary?: () => void;
	onNewChat: () => void;
	onSearch: () => void;
	onConnection: (id: string) => void;
}

export default function WorkspaceTitlebar(p: Props) {
	const noun = p.kind === 'code' ? 'task' : 'chat';
	return (
		<header className="app-titlebar">
			<div className="titlebar-controls">
				{!p.settingsOpen && (
					<>
						<button
							className="icon-button"
							aria-label={p.panelOpen ? 'Collapse sidebar' : 'Expand sidebar'}
							aria-expanded={p.panelOpen}
							title={p.panelOpen ? 'Collapse sidebar' : 'Expand sidebar'}
							onClick={p.onTogglePanel}
						>
							{p.panelOpen ? <PanelLeftClose size={16} /> : <PanelLeft size={16} />}
						</button>
						{!p.panelOpen && p.conversation && (
							<>
								<button
									className="icon-button"
									aria-label={`New ${noun}`}
									title={`New ${noun}`}
									onClick={p.onNewChat}
								>
									<SquarePen size={16} />
								</button>
								<button
									className="icon-button"
									aria-label={`Search ${noun}s`}
									title={`Search ${noun}s`}
									onClick={p.onSearch}
								>
									<Search size={16} />
								</button>
							</>
						)}
					</>
				)}
			</div>
			<div
				className="titlebar-title"
				title={p.projectName ? `${p.projectName} · ${p.title}` : p.title}
			>
				{p.projectName ? <Folder size={15} /> : p.conversation ? <MessageCircle size={15} /> : null}
				<span>{p.title}</span>
			</div>
			{p.conversation && (
				<div className="titlebar-actions">
					<Select
						className="connection-select"
						aria-label="Active connection"
						disabled={p.busy}
						value={p.connection?.id ?? ''}
						onChange={p.onConnection}
						options={p.connections.map((connection) => ({
							value: connection.id,
							label: connection.name,
						}))}
					/>
					{p.thread && p.thread.messages.length > 0 && (
						<button
							className="icon-button"
							aria-label={`Export ${noun}`}
							title={`Export ${noun}`}
							onClick={() =>
								downloadText(
									`${p.thread!.title.replace(/[^\w -]/g, '').slice(0, 60) || noun}.md`,
									`# ${p.thread!.title}\n\n${p.thread!.messages.map((message) => `## ${message.role === 'user' ? 'You' : 'Assistant'}\n\n${message.content}${message.error ? `\n\nError: ${message.error}` : ''}`).join('\n\n')}`,
								)
							}
						>
							<Download size={16} />
						</button>
					)}
					{p.pinnedSummaryAvailable && (
						<button
							className="icon-button titlebar-summary-toggle"
							aria-label={p.pinnedSummaryOpen ? 'Hide pinned summary' : 'Show pinned summary'}
							title={p.pinnedSummaryOpen ? 'Hide pinned summary' : 'Show pinned summary'}
							aria-pressed={!!p.pinnedSummaryOpen}
							aria-controls="pinned-summary-panel"
							onClick={p.onTogglePinnedSummary}
						>
							<svg
								width="18"
								height="18"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="1.7"
								strokeLinecap="round"
								aria-hidden="true"
							>
								<circle cx="5" cy="7" r="2.5" />
								<circle cx="5" cy="17" r="2.5" />
								<path d="M12 7h9M12 17h9" />
							</svg>
						</button>
					)}
					{p.kind === 'code' && p.onToggleWorkspaceTabs && (
						<button
							className="icon-button titlebar-workspace-toggle"
							aria-label={p.workspaceTabsOpen ? 'Hide workspace tabs' : 'Show workspace tabs'}
							title={p.workspaceTabsOpen ? 'Hide workspace tabs' : 'Show workspace tabs'}
							aria-pressed={!!p.workspaceTabsOpen}
							onClick={p.onToggleWorkspaceTabs}
						>
							<span className="titlebar-tab-count">{p.workspaceTabCount || 0}</span>
						</button>
					)}
				</div>
			)}
		</header>
	);
}
