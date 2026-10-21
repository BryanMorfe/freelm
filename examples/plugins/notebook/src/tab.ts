import { invoke } from '@freelm/plugin-ui';
import './tab.css';

// This DOM belongs to an isolated plugin view, not FreeLM's renderer.
const main = document.createElement('main');
main.innerHTML = `<h1>Notebook</h1>
<p>Your own space, shared with assistants only when you enable this plugin's tools.</p>
<label for="note">Note</label>
<textarea id="note" placeholder="Write something worth keeping…" maxlength="10000"></textarea>
<div class="actions"><button id="save">Save note</button><span id="status" role="status"></span></div>`;
document.body.append(main);
const note = document.querySelector<HTMLTextAreaElement>('#note')!;
const status = document.querySelector<HTMLSpanElement>('#status')!;
const save = document.querySelector<HTMLButtonElement>('#save')!;
let revision = 0;
note.addEventListener('input', () => { revision++; status.textContent = 'Unsaved changes'; });
save.addEventListener('click', async () => {
  const savingRevision = revision;
  save.disabled = true;
  status.textContent = 'Saving…';
  try {
    await invoke('save_note', { text: note.value });
    status.textContent = savingRevision === revision ? 'Saved on this computer' : 'Unsaved changes';
  } catch (error) { status.textContent = error instanceof Error ? error.message : 'Could not save note.'; }
  finally { save.disabled = false; }
});
const openingRevision = revision;
invoke('read_note', {}).then(value => {
  if (revision === openingRevision && value && typeof value === 'object' && 'text' in value && typeof value.text === 'string')
    note.value = value.text;
}).catch(error => { status.textContent = String(error); });
