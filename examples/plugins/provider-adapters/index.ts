import { definePlugin } from '@freelm/plugin-sdk';
import unconventional from './unconventional';
import messages from './anthropic-like';

export default definePlugin({ providers: { ...unconventional.providers, ...messages.providers } });
