import { definePlugin, type PluginHandler } from '@freelm/plugin-sdk';

const readNote: PluginHandler = async (_args, context) => ({
  text: (await context.storage.get('note')) ?? '',
});
const saveNote: PluginHandler = async (args, context) => {
  if (typeof args.text !== 'string' || args.text.length > 10000)
    throw new Error('A note must be text with at most 10,000 characters.');
  await context.storage.set('note', args.text);
  return { saved: true };
};
export default definePlugin({
  tools: { read_note: readNote, save_note: saveNote },
  actions: { read_note: readNote, save_note: saveNote },
});
