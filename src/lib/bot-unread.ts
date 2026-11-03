import type { BotConversation } from '../bot-types';
/** Derive from durable read state; never increment a separate notification counter. */
export function unreadBotMessages(conversations: readonly BotConversation[]): number {
 const unread = new Set<string>();
 for (const conversation of conversations) {
  for (const message of conversation.messages) {
   if (message.role === 'bot' && message.status === 'completed' &&
       (message.content.trim() || message.attachments?.length) &&
       message.updatedAt > conversation.readAt) {
    unread.add(JSON.stringify([conversation.id, message.id]));
   }
  }
 }
 return unread.size;
}
