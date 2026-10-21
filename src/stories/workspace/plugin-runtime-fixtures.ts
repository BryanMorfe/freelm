import type { PluginLocalManifest } from '../../plugin-types';
export const notesManifest: PluginLocalManifest = {
	manifestVersion: 2,
	id: 'sample.notes',
	name: 'Sample Notes',
	version: '1.0.0',
	author: 'FreeLM examples',
	description: 'A small notebook with account-scoped storage and tools.',
	auth: { type: 'none' },
	runtime: { apiVersion: 1, entry: 'runtime.ts' },
	permissions: { network: [], storage: true },
	contributes: {
		tools: [
			{
				name: 'read_note',
				description: 'Read the saved note.',
				parameters: { type: 'object' },
				readOnly: true,
			},
		],
		tabs: [{ id: 'notes', title: 'Notebook', entry: 'ui.ts', icon: 'notebook' }],
		actions: ['read_note', 'save_note'],
	},
};
export const notesTabHTML = `<!doctype html><html data-theme="__FREELM_PLUGIN_THEME__"><head><style>
:root{color-scheme:dark;color:#eee;background:#181818;font:14px system-ui} :root[data-theme=light]{color-scheme:light;color:#222;background:#fff}body{margin:0;padding:28px}h2{font-size:20px;margin:0 0 8px}p{color:#888;line-height:1.5}textarea{font:14px system-ui;width:100%;box-sizing:border-box;min-height:200px;padding:14px;border-radius:12px;border:1px solid #7775;background:transparent;color:inherit;resize:vertical}button{font:13px system-ui;padding:8px 15px;border-radius:8px;border:1px solid #7775;margin-top:12px;background:#7772;color:inherit}#status{font-size:13px}
</style></head><body><h2>A place to think</h2><p>This independently packaged interface only talks to FreeLM through declared plugin actions.</p><textarea aria-label="Note">Ideas for the next release…</textarea><button id="save">Save note</button><p id="status">Changes in this preview stay here.</p><script>
const nonce='__FREELM_PLUGIN_CHANNEL__';let id=0;document.getElementById('save').onclick=()=>parent.postMessage({protocol:'freelm-plugin-ui-v1',nonce,id:String(++id),action:'save_note',args:{content:document.querySelector('textarea').value}},'*');addEventListener('message',e=>{if(e.source===parent&&e.data.protocol==='freelm-plugin-ui-v1'&&e.data.nonce===nonce)document.getElementById('status').textContent=e.data.error||'Note saved.'});
</script></body></html>`;
