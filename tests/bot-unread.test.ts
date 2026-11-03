import { expect, it } from 'vitest';
import { unreadBotMessages } from '../src/lib/bot-unread';
import type { BotConversation } from '../src/bot-types';
const conversation = (readAt = 0) => ({ id: 'thread', readAt, messages: [
 { id: 'a', role: 'bot', status: 'completed', content: 'reply', updatedAt: 10 },
 { id: 'b', role: 'bot', status: 'pending', content: 'stream', updatedAt: 20 },
 { id: 'c', role: 'user', status: 'completed', content: 'send', updatedAt: 20 },
 { id: 'd', role: 'bot', status: 'failed', content: 'error', updatedAt: 20 },
] }) as BotConversation;
it('counts incoming completed messages, deduplicating replay and ignoring streaming/status/outgoing', () => {
 const c = conversation();
 expect(unreadBotMessages([c, c])).toBe(1);
 expect(unreadBotMessages(JSON.parse(JSON.stringify([c])))).toBe(1);
});
it('decrements from durable read state, clears on read/removal and counts new messages', () => {
 const c = conversation(10);
 expect(unreadBotMessages([c])).toBe(0);
 c.messages.push({ ...c.messages[0], id: 'next', updatedAt: 11 });
 expect(unreadBotMessages([c])).toBe(1);
 c.readAt = 11;
 expect(unreadBotMessages([c])).toBe(0);
 expect(unreadBotMessages([])).toBe(0);
});
