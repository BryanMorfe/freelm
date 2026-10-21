# Workflows

Workflows is a local-host visual editor and durable execution service. A workflow describes a reusable process; a project supplies context and configuration; a run supplies a particular request. Open **Workflows** to create a library workflow or choose a template, then **Add to project**. The **Transform data** template needs no model or provider.

## Library, project, and run

| Concept          | Ownership and behavior                                                                                                                                                                        |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Library workflow | A reusable graph with its request fields, nodes, tools, and outputs. It can be added to multiple projects.                                                                                    |
| Project workflow | An independent binding to a pinned copy of the library graph and every transitive child workflow. It has its own model overrides, permissions, default inputs, persistent state, and history. |
| Run              | One request and its durable progress, results, project context, and complete graph snapshots. Nested runs inherit the same project and investigation.                                         |

In the Code sidebar, each local project's **+** opens **New task** and **Add workflow**. Adding a workflow does not enable automatic triggers or execute it. Opening a project workflow opens its request-and-results view. Enter a request, optionally complete its additional fields, and start a run. History lists that project's investigations, with progress, results, cancellation, human waits, and retry where applicable. The canvas remains available for authoring.

Library edits do not silently change existing project workflows. **Edit workflow** opens the project's pinned graph; those edits and `workflows.update` preserve the binding and its history without changing the library. Revision checks preserve unsaved drafts when a concurrent edit conflicts. Existing runs always retain their original graphs, including child definitions: editing or deleting a library child after admission cannot change the current investigation. A project-specific workflow created by a Code agent belongs to that project and is not automatically published to the library.

Project configuration overrides connection, model, and thinking effort for Text and Agent nodes. This first slice adds workflows to local Code projects, which supply their directories and instructions; the first directory is the default working directory. Code creates a managed project directory when none is supplied. A project must exist on this computer and have a directory before its workflow can run. Chat-only projects and remote project installations are not exposed here. Missing projects or directories never fall back silently to the global workspace. Bound Thread actions and thread Context reads are restricted to threads in the same project.

Each new run starts a new investigation collection. The research templates do not implicitly include findings from earlier runs. Continuing a paused or interrupted run preserves its existing investigation; starting a new run with selected earlier findings is a separate explicit request, not an automatic memory merge. Workflow-wide State and collections can deliberately persist information between runs, scoped to the project binding and workflow definition. The same library workflow added to another project cannot read those records.

## Request inputs

The Manual entry node has a configurable request contract: a main text field plus optional text, number, boolean, list, or object fields. The contract is stored as `WorkflowDefinition.request`; the composer renders these fields without requiring a JSON request body. Required fields and types are validated before admission. Additional request fields may have defaults.

The UI, Code tools, triggers, and child workflows use the same input normalizer. A generic `prompt` or `text` is mapped to the declared primary field, such as `goal`. An explicit request overrides the project's saved default; a missing required question fails rather than substituting a sample topic. Workflows without a request contract retain their existing pass-through input behavior.

## Canvas and configuration

- Pan the canvas, zoom around the pointer, fit the graph, and drag nodes. Connect an output socket to a compatible input socket. Select a connection to remove it.
- Search the node catalog. Node ports describe the data they carry; an `any` port accepts any value. The inspector shows model configuration, fields, tools, and skills appropriate to the node.
- Graph edits save automatically. Undo/redo changes the draft graph. A running workflow keeps its original graph snapshot.
- The run inspector shows each step, its status, results, and errors. Media outputs have local previews; binary content is stored as host-managed files rather than embedded in graph JSON.
- Workflows use this computer's connections and configuration, even if another FreeLM workspace is selected. Workflow definitions and runs are not synchronized to remotes in this version.

## Base nodes

| Category     | Nodes                                                                                        |
| ------------ | -------------------------------------------------------------------------------------------- |
| Triggers     | Manual trigger, Schedule, Event trigger                                                      |
| AI and media | Text generation, Agent, Image generation, Video generation, Speech generation, Transcription |
| Actions      | Tool call, Run code, Thread, Save file, Notification, Output                                 |
| Flow control | Condition, For each, Join, Repeat, Feedback loop, Wait / approval, Subworkflow               |
| Data         | Value, Context, Transform, Media transform, State, Shared collection                         |

Text generation supports structured JSON and image inputs. Agent nodes run a tool loop with the selected tools and skills. Both can request JSON/schema output through the provider's format parameter and validate the final result locally. Invalid final JSON can receive up to two formatting-only correction requests; these cannot invoke tools or replay their side effects. An invalid schema fails before inference or tool execution. Tool call nodes execute a configured built-in, MCP, or plugin tool. Run code transforms data in the existing isolated JavaScript or Python runtime.

Image/video generation uses the existing model settings and input/output moderation pipeline. Speech and transcription use configured audio models. Media transform currently resizes, crops, and converts images; audio/video editing is not implemented.

Thread nodes use the existing thread service to create, read, send to, wait on, archive, rename, or stop Chat/Code threads. Thread actions require the FreeLM renderer to be available, unlike ordinary graph and inference execution. Computer Use and renderer-only agent question tools are not available in workflow agents in this version; use a Wait / approval node for human review.

Context can read run data, UTF-8 workspace files, or a thread. Transform supports templates, JSON parse/stringify, property extraction, split/join, merge, and pick. State stores JSON values across runs of the same project workflow; unbound library workflows retain their legacy workflow-wide scope. For each and Repeat invoke a reusable child workflow; loops are bounded to 100 iterations and recursive workflows are rejected before admission. Ordinary graph edges cannot form cycles.

Templates accept `{{input}}`, `{{inputs.portName}}`, `{{run.inputs.field}}`, `{{trigger.payload.field}}`, and `{{nodes.nodeId.field}}`. An exact template expression preserves its value type; an expression inside other text becomes a string.

## Feedback and shared records

**Feedback loop** executes a child workflow sequentially. Its first `current`/`value` is the connected seed; later rounds receive the preceding round's result. The child receives `iteration` (one-based), `index` (zero-based), and the outer inputs. It must publish a named Output, normally `result`. The loop checkpoints each completed round before starting the next, supports minimum/maximum rounds and a stop predicate on the result, and exposes the final value, all round results, iteration count, stop status, and child run IDs. Rounds are bounded to 100. Existing Repeat retains its independent repeated-run behavior.

**Shared collection** stores JSON records with stable IDs, revisions, timestamps, and writer provenance. Investigation scope (`run`) shares records across a root run and all its descendants, while isolating separate investigations. Workflow scope shares records across runs of the same definition within one project binding; unbound workflows retain their legacy scope. Operations are list, get, append, upsert, and delete, with equality filters, literal text search, and pagination. Mutations are serialized per collection and saved atomically. Expected revision guards prevent stale overwrites; revision zero requires an absent record. Stable mutation receipts prevent duplicate writes on retry or restart. Records are limited to 256 KiB, collections to 8 MiB, and list response pages to 2 MiB. These are ordinary records, not semantic/vector memory.

## Research templates

**Research team** creates a parent workflow and an editable child round using generation, critique, refinement, and meta-review Agent nodes. **Co-Scientist** extends that pattern with proximity/grouping and pairwise ranking roles, plus deterministic Elo updates. Both use generic Feedback loop, Shared collection, Code, and Output nodes; the runtime has no research-specific behavior.

The templates are topic-agnostic. The request composer requires a **Research question** and accepts optional **Constraints or success criteria** and **Reference notes and links**. The same Co-Scientist graph can investigate software systems, materials, mathematics, or another research subject; there is no default local-inference question in newly created templates. The preparation step also accepts `goal`, `prompt`, or `text` from programmatic callers. Previously saved library graphs and completed trials remain unchanged.

Templates created in the UI use the configured Chat model and thinking effort; a project may override them. Templates created by Code inherit the initiating Code thread's connection, model, effort, and permission ceiling. UI and Code template creation select `web.run` for generation/review agents only when the host advertises it; a tool being available does not establish that the model actually used it. Other agents receive accumulated evidence and critiques. Co-Scientist performs two rounds by default, then synthesizes a Markdown proposal and publishes the investigation records.

Ordinary Code nodes prepare model context for each round and the final report: the current state appears once, followed by at most eight compact summaries of older rounds. The current round is excluded from those summaries. Their editable 96,000-character context budget removes older summaries first and reports an error if the current state alone is too large. Full collection records remain preserved and available in the investigation-records output.

The template is inspired by [Google's published Co-Scientist architecture](https://www.nature.com/articles/s41586-026-10644-y). It is a bounded research proposal workflow, not a reproduction of Google's adaptive supervisor. Pairwise judgments and Elo scores prioritize ideas; they do not establish scientific correctness. The workflow proposes experiments without running them and instructs agents to distinguish retrieved evidence, hypotheses, and measured results. All roles, tools, schemas, prompts, and loop controls remain editable.

## Code workflow tools

Local Code threads inside a project can discover and manage workflows with the following tools:

| Tool                 | Purpose                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| `workflows.list`     | List this project's workflows or available library definitions.                                  |
| `workflows.catalog`  | Inspect supported node types, ports, configuration fields, templates, and available tool names.  |
| `workflows.inspect`  | Read a project's graph, pinned dependencies, or run history.                                     |
| `workflows.validate` | Validate an authored graph and supplied children without executing it.                           |
| `workflows.create`   | Add a library workflow, instantiate a template, or create a private project graph.               |
| `workflows.update`   | Replace a project's graph using its current revision, without changing the library or past runs. |
| `workflows.run`      | Admit a new request asynchronously and return its run ID.                                        |
| `workflows.read_run` | Read bounded status, results, or one node's details.                                             |
| `workflows.cancel`   | Cancel an accessible run and its active descendants.                                             |

The catalog pages node definitions with `offset`/`limit` and tool discovery independently with `toolOffset`/`toolLimit` (20 tools by default, at most 50). Tool pages return `items`, `total`, and `nextOffset`, with descriptions capped at 500 characters.

Project and thread identity come from the host, not model arguments. Authored graphs cannot override host-owned workspace, project, or permission fields. A run cannot gain broader permissions than the initiating Code thread; the same ceiling follows child runs. Plan mode permits discovery, inspection, validation, and result reading, but not create/update/run/cancel mutations.

Creation and execution require idempotency keys so an identical retried tool call does not create another binding or run. Execution admission is not completion. Terminal outcomes are delivered asynchronously to the originating Code thread through its durable message queue, after checking that the thread still belongs to the same project. Delivery waits for the renderer to be ready; archived, temporary, deleted, or moved threads do not receive it. Completion messages contain identifiers and status, with results retrieved through `workflows.read_run`. They do not instruct the agent to start another investigation. Remote Code sessions do not receive these workflow tools in this version.

## Scheduling and triggers

Save a library workflow with its triggers enabled to activate its existing schedules and event listeners. Manual runs remain available with triggers disabled. These schedules still target unbound library workflows: adding a workflow to a project does not install a project-specific schedule or event subscription. Project bindings currently run through their request composer or Code tools. Agent-created workflows leave automatic triggers disabled. Per-project schedules and event subscriptions are separate future work.

Schedules support once, intervals, daily, and weekly execution with a time zone, missed-run policy (skip or run once on return), and overlap policy (skip or queue). They execute while the owning FreeLM process is running. They do not wake a sleeping computer or run while FreeLM is quit. Missed occurrences never cause an unbounded catch-up burst.

Event triggers match a named event with optional payload filters. `file.changed` watches a configured path with debounce. `thread.completed` is emitted when a non-temporary Chat/Code response finishes, with `threadId`, `title`, and `workspaceId`. The editor can emit a named event for testing. External HTTP webhooks and plugin event publication are not exposed in this version.

## Execution and recovery

Execution lives in Electron's main process, separate from the canvas. Switching views does not stop a run. Independent ready branches run with bounded concurrency and Join waits for its dependencies. A branch excluded by a Condition is skipped.

Definitions, project bindings, run records, completion receipts, schedule cursors, and workflow state are stored under `~/.freelm/workflows` (or the configured FreeLM home). Bindings are individual atomic records under `bindings/`; they do not depend on mutable library files at execution time. Every side-effecting step has an intent checkpoint before execution. Completed results are preserved. A restart marks an active step interrupted and requires an explicit retry; FreeLM does not assume a provider request, file write, or external tool action was rolled back. Review external effects before retrying an interrupted step. Human and timed waits survive restart. Detaching a project workflow removes the binding without deleting historical runs or cancelling an already admitted run.

Tool actions use FreeLM's normal approval broker and automatic reviewer. Workflow permissions default to Ask. Selected agent tools constrain nested orchestration as well as direct calls. File reads and saves stay within the workflow workspace or managed artifacts; saves do not overwrite existing files unless explicitly configured. Cancellation stops local work and cancels in-flight requests where supported; it cannot undo completed external effects.

## Implementation

- Shared types: `src/workflow-types.ts`
- Request normalization and Code tool schemas: `src/lib/workflow-inputs.ts`, `workflow-tools.ts`
- Node catalog/templates: `src/lib/workflow-catalog.ts`
- Research template factory: `src/lib/workflow-research.ts`
- Canvas, inspector, sidebar, project run view: `src/components/WorkflowsFeature.tsx`, `WorkflowProjectView.tsx`, `workflows.css`
- Durable engine/store/scheduler: `electron/workflows/engine.ts`, `store.ts`, `scheduler.ts`
- Shared records and output validation: `electron/workflows/collections.ts`, `structured-output.ts`
- Inference/tool/files/media adapters: `electron/workflows/adapters.ts`, `assets.ts`, `media-transform.ts`
- Project-scoped Code tools and asynchronous completion delivery: `electron/workflows/tool-service.ts`, `notifications.ts`
- Media capabilities: `electron/workflows/previews.ts`
- Main/preload integration: `electron/main.ts`, `electron/preload.ts`

Plugin-defined node types and remote workflow execution remain future extensions. The built-in graph format is versioned independently of provider requests.

## Checks

Run `npx vitest run tests/workflow-engine.test.ts tests/workflow-adapters.test.ts tests/workflow-previews.test.ts` for engine, adapter, and asset boundary checks. `tests/e2e/workflows.spec.ts` tests the actual editor with an isolated durable engine. After `npm run build`, `npm run test:workflows` launches an isolated Electron profile and local fixture provider; it checks actual inference/tool dispatch, approvals, code execution, export, media previews, and recovery without reading or changing the user's profile.

Feedback, collection, schema, and research-template checks are in `tests/workflow-feedback.test.ts`, `tests/workflow-collections.test.ts`, `tests/workflow-structured-output.test.ts`, and `tests/workflow-research.test.ts`. After building, `node scripts/smoke-workflow-feedback.mjs` verifies structured Agent execution, tool-free format correction, sequential feedback, shared records, and restart recovery through the native bridge in an isolated profile. Set `FREELM_SMOKE_EXECUTABLE` to a packaged FreeLM executable to validate the signed application.

Project binding checks are in `tests/workflow-projects.test.ts`: two projects using one library definition keep their questions, state, collections, and history separate across restart; nested definitions stay pinned; private edits preserve old runs; permissions and project context follow children; and concurrent retried admissions are deduplicated. `tests/workflow-tools.test.ts` checks Code tool scope and authoring contracts. Adapter tests cover project-scoped Thread/Context actions and inherited project instructions. These fixture checks establish execution and isolation behavior, not scientific validity or live provider retrieval quality.

After building, `node scripts/smoke-workflow-projects.mjs` drives the real Code composer and native tool runtime with a loopback provider in a disposable profile. It verifies authoring, shared-library installation into two projects, asynchronous admission, isolated evidence, completion delivery and result reading, cross-project read rejection, and restart without replay. It also accepts `FREELM_SMOKE_EXECUTABLE` for packaged verification.
