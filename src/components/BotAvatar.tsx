import type { CSSProperties } from 'react';
import { Sparkles, Users } from 'lucide-react';

export const BOT_COLORS = ['#3c8c74', '#4a79cc', '#8762bd', '#c36e89', '#b4833d', '#66899b'];

export default function BotAvatar({
	name,
	color = BOT_COLORS[0],
	emoji,
	size = 36,
	group = false,
}: {
	name: string;
	color?: string;
	emoji?: string;
	size?: number;
	group?: boolean;
}) {
	return (
		<span
			className={`bot-avatar${group ? ' bot-avatar-group' : ''}`}
			style={
				{ '--bot-color': color, width: size, height: size, fontSize: size * 0.43 } as CSSProperties
			}
			aria-hidden="true"
		>
			{group ? (
				<Users size={size * 0.48} />
			) : (
				emoji ||
				(name.trim() ? Array.from(name.trim())[0].toUpperCase() : <Sparkles size={size * 0.48} />)
			)}
		</span>
	);
}
