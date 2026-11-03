# Live workflow definitions

The library, project installations and active runs are separate scopes. Library
changes affect future library admissions. Project bindings and admitted runs
retain their pinned root and dependency snapshots, including across refresh.

## Saving and refreshing

Library writes are serialized within the engine. The canvas and library tools
send the inspected revision plus a SHA-256 hash of canonical definition content.
Existing disk content is compared before a write. A stale revision, a same-revision
content edit, or an external deletion rejects the save. Revision allocation occurs
inside the serialization barrier; create-if-absent uses revision zero.

The Workflows header's **Refresh definitions from disk** action reads definitions
without writing or incrementing their revisions. There is no automatic definition
adoption or directory watcher. Invalid files produce visible per-file diagnostics.
The engine validates dependency closure before replacing its definition map; an
invalid dependency component retains its previous valid generation, while unrelated
valid definitions can update. On cold start there is no previous generation to keep.
Dirty canvas drafts retain their original base and remain visible through refresh.
After a conflict, keep a disabled copy or explicitly discard the draft and reload.

A changed library generation clears stale pending file-event debounce timers.
Pending events whose root and dependency content are unchanged remain scheduled;
subsequent events use newly registered watchers.
Automatic schedule/event admissions also compare the captured root and dependency
content before admission. Active and already admitted runs are not cancelled.

## Agent tools and authority

- `workflows.library_inspect` reads one shared library definition, its revision and
  content hash. Its bounded graph excerpt is data, not authorization.
- `workflows.library_save` creates or replaces a shared definition. Replacements
  require the inspected base. Creation requires a new ID and `expectedRevision: 0`.
  New definitions are disabled. Replacements preserve enabled state and host-owned
  settings. The tool cannot override model/permission authority in node configuration.
- Existing `workflows.create` / `workflows.update` continue to manage project
  installations. They do not silently become library edits.

All these tools retain local Code/project scope and live host scope checks. Library
inspection is allowed in Plan; library writes are blocked in Plan and pass through
the existing Code consent policy (Ask/automatic review/explicit Full access).
Denied approval executes no write. Remote clients do not receive these tools.
The change does not grant an agent permission or alter owner permission settings.

## Limits

The engine serializes its own writers, not arbitrary filesystem processes. The
read/compare/atomic-file-replace sequence is not a universal filesystem CAS: an
external writer can race between comparison and replacement. A refresh is a scan,
not a transactional multi-file filesystem snapshot. Write external bundles atomically
and finish them before explicit refresh; use FreeLM's guarded save path for concurrent
app edits. Invalid partial bundles are isolated, but a concurrently changing yet valid
bundle cannot be proven to represent one external transaction.

Draft recovery is in the open editor; it is not a new durable draft store. Active
run and binding persistence retain their established restart behavior.
