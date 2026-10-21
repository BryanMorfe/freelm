import {
	Monitor,
	BookOpen,
	Brain,
	CircleHelp,
	FileImage,
	FilePenLine,
	Globe,
	Image,
	Link,
	ListChecks,
	MessageSquare,
	MessagesSquare,
	NotebookText,
	Plug,
	Search,
	SquareTerminal,
	Wrench,
	Video,
	type LucideIcon,
} from 'lucide-react';
import type { ToolCallRecord } from '../agent-types';
import { toolArguments } from '../lib/message-activity';
import './activity-icon.css';

interface IconDefinition {
	icon: LucideIcon;
	name: string;
}

const search: IconDefinition = { icon: Search, name: 'search' };
const terminal: IconDefinition = { icon: SquareTerminal, name: 'terminal' };
const image: IconDefinition = { icon: Image, name: 'image' };
const memory: IconDefinition = { icon: Brain, name: 'memory' };
const toolIcons: Record<string, IconDefinition> = {
	computer_apps: { icon: Monitor, name: 'computer' },
	computer_open: { icon: Monitor, name: 'computer' },
	computer_observe: { icon: Monitor, name: 'computer' },
	computer_act: { icon: Monitor, name: 'computer' },
	computer_close: { icon: Monitor, name: 'computer' },
	exec_command: terminal,
	write_stdin: terminal,
	'python.exec': terminal,
	apply_patch: { icon: FilePenLine, name: 'file-edit' },
	view_image: image,
	'image.view': image,
	'image_gen.imagegen': image,
	'video_gen.videogen': { icon: Video, name: 'video' },
	update_plan: { icon: ListChecks, name: 'plan' },
	request_user_input: { icon: CircleHelp, name: 'question' },
	send_message_to_user_async: { icon: MessageSquare, name: 'message' },
	tool_search: search,
	'skills.list': search,
	'skills.read': { icon: BookOpen, name: 'skill' },
	'conversations.search': search,
	'conversations.read': { icon: MessagesSquare, name: 'conversation' },
	'memory.search': search,
	'memory.read': { icon: NotebookText, name: 'memory-read' },
	'memory.create': memory,
	'memory.update': memory,
	'memory.delete': memory,
};

function Icon({ icon: Component, name }: IconDefinition) {
	return (
		<Component
			size={15}
			strokeWidth={1.7}
			className="activity-icon"
			data-activity-icon={name}
			aria-hidden="true"
			focusable="false"
		/>
	);
}

/** Live progress and saved tool history always use the same tool-aware icon. */
export default function ToolActivityIcon({ call }: { call: ToolCallRecord }) {
	if (call.name === 'web.run') {
		const args = toolArguments(call);
		if (Array.isArray(args.search_query) || Array.isArray(args.image_query))
			return <Icon {...search} />;
		if (Array.isArray(args.screenshot)) return <Icon icon={FileImage} name="pdf" />;
		if (Array.isArray(args.find)) return <Icon {...search} />;
		if (Array.isArray(args.click)) return <Icon icon={Link} name="link" />;
		return <Icon icon={Globe} name="globe" />;
	}
	const definition = Object.hasOwn(toolIcons, call.name) ? toolIcons[call.name] : undefined;
	if (definition) return <Icon {...definition} />;
	return call.name.startsWith('mcp_') ? (
		<Icon icon={Plug} name="integration" />
	) : (
		<Icon icon={Wrench} name="tool" />
	);
}

export function ReasoningActivityIcon({ code = false }: { code?: boolean }) {
	return code ? <Icon icon={Wrench} name="working" /> : <Icon icon={Brain} name="thinking" />;
}
