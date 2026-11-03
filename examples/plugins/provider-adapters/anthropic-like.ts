import { definePlugin } from '@freelm/plugin-sdk';

/** Synthetic text/tool subset. Not a certified live-provider integration. */
export default definePlugin({
  providers: {
    messages: ({ phase, input, state }) => {
      const value = input as any,
        current = (state ?? { blocks: {}, reason: 'stop' }) as any;
      if (phase === 'request')
        return {
          path: '/messages',
          format: 'sse',
          headers: { 'anthropic-version': '2023-06-01' },
          body: {
            model: value.model,
            system: value.system,
            max_tokens: value.maxOutputTokens,
            stream: true,
            tools: value.tools.map((t: any) => ({
              name: t.name,
              description: t.description,
              input_schema: t.parameters,
          ...(t.strict === undefined ? {} : { strict: t.strict }),
            })),
            messages: value.messages.map((m: any) =>
              m.role === 'tool'
                ? {
                    role: 'user',
                    content: [{ type: 'tool_result', tool_use_id: m.callId, content: m.text }],
                  }
                : {
                    role: m.role,
                    content: [
                      ...(m.text ? [{ type: 'text', text: m.text }] : []),
                      ...(m.calls ?? []).map((c: any) => ({
                        type: 'tool_use',
                        id: c.id,
                        name: c.name,
                        input: c.arguments,
                      })),
                    ],
                  },
            ),
          },
        };
      const events: any[] = [];
      if (phase === 'response')
        return {
          events: [
            { type: 'error', code: 'provider', message: 'Messages endpoint rejected request.' },
          ],
        };
      if (phase === 'frame') {
        const frame = JSON.parse(value.data);
        if (frame.type === 'content_block_start' && frame.content_block.type === 'tool_use') {
          current.blocks[frame.index] = frame.content_block.id;
          events.push({
            type: 'tool-start',
            id: frame.content_block.id,
            name: frame.content_block.name,
          });
        }
        if (frame.type === 'content_block_delta') {
          if (frame.delta.type === 'text_delta')
            events.push({ type: 'text', text: frame.delta.text });
          if (frame.delta.type === 'input_json_delta')
            events.push({
              type: 'tool-delta',
              id: current.blocks[frame.index],
              text: frame.delta.partial_json,
            });
        }
        if (frame.type === 'content_block_stop' && current.blocks[frame.index])
          events.push({ type: 'tool-end', id: current.blocks[frame.index] });
        if (frame.type === 'message_start' && frame.message.usage)
          events.push({ type: 'usage', inputTokens: frame.message.usage.input_tokens });
        if (frame.type === 'message_delta') {
          current.reason = frame.delta.stop_reason === 'tool_use' ? 'tools' : 'stop';
          if (frame.delta.stop_reason === 'max_tokens')
            events.push({ type: 'error', code: 'length', message: 'Output limit reached.' });
          if (frame.usage) events.push({ type: 'usage', outputTokens: frame.usage.output_tokens });
        }
        if (frame.type === 'message_stop') events.push({ type: 'finish', reason: current.reason });
        if (frame.type === 'error')
          events.push({ type: 'error', code: 'provider', message: frame.error.message });
      }
      return { state: current, events };
    },
  },
});
