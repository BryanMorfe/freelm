import { definePlugin } from '@freelm/plugin-sdk';

/** Synthetic protocol: /generate accepts turns and returns nested answer.text. */
export default definePlugin({
  providers: {
    unconventional: ({ phase, input }) => {
      const value = input as any;
      if (phase === 'request')
        return {
          path: '/generate',
          format: 'json',
          body: {
            engine: value.model,
            instruction: value.system,
            turns: value.messages.map((m: any) => ({ speaker: m.role, value: m.text })),
            limit: value.maxOutputTokens,
          },
        };
      if (phase === 'response') {
        if (value.status !== 200)
          return {
            events: [
              { type: 'error', code: 'provider', message: 'Synthetic endpoint rejected request.' },
            ],
          };
        const body = JSON.parse(value.body);
        return {
          events: [
            { type: 'text', text: body.answer.text },
            { type: 'finish', reason: 'stop' },
          ],
        };
      }
      return { events: [] };
    },
  },
});
