import type { BotHostIdentity, BotProfile } from '../bot-types';

export interface BotContact {
	bot: BotProfile;
	host: BotHostIdentity;
}
export function botContactKey(contact: BotContact) {
	return `${contact.host.id}:${contact.bot.id}`;
}
