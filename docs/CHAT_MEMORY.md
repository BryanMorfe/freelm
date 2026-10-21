# Chat memory

FreeLM keeps two kinds of memory in the active workspace. Memory applies to Chat; Code does not receive memory context or memory tools.

## Conversation continuity

The system prompt receives a bounded digest of up to five recent eligible conversations. A project chat references only other Chat threads in that project. A chat outside projects references only other chats outside projects. Connection/model selection does not change this boundary. Code threads and the current thread are excluded.

After a successful Chat turn, FreeLM creates or refreshes summaries in a serialized background queue using the source conversation’s configured text model and explicit thinking mode. Foreground Chat requests, workspace switching and app closure cancel the queue. Each summary carries a revision of its source transcript; changed, moved or deleted sources invalidate in-flight results. A provider failure leaves original history available. Existing unsummarized threads initially contribute clearly labeled excerpts, then receive summaries after a successful turn in that scope.

Summaries are derived, lossy context. Original messages remain authoritative. `conversations.search` performs literal, case-insensitive keyword matching over original user and final assistant prose, and returns thread/message IDs and excerpts. `conversations.read` reads message pages or a character window within one message. These tools enforce the same scope as prompt injection and use bounded output with continuation offsets. Search yields periodically so a large history does not monopolize the renderer. Attachments, inline assets, private reasoning and raw tool results/transcripts are excluded.

## Saved notes

Saved memories are independent records with an ID, content, scope, timestamps, revision and provenance. Workspace notes are available to every Chat in that workspace. Project notes are available only inside that project. A model-created note defaults to the current project, or the workspace for a chat outside projects; tool arguments cannot select another project.

The model can use `memory.search`, `memory.read`, `memory.create`, `memory.update` and `memory.delete`. Updates/deletions require the latest revision. Exact duplicate notes in the same scope reuse the existing record. A successful write is acknowledged only after the existing workspace persistence queue saves it. These are application-managed documents and grant no local-file or command access. Chat-only memory tools work without enabling Code, image generation or web browsing.

Saved notes enter the system prompt with a 16,000-character budget. Recent conversation context has an 8,000-character budget. The prompt marks historical content as data and reports omitted notes; retrieval tools provide further detail. The initial limits are 256 notes and 4,000 characters per note or summary. No embedding API is required.

Settings → Personal → Memories provides creation, editing, deletion and filtering, plus separate **Use saved memories** and **Reference chat history** toggles. Both default on. Turning a capability off removes its context/tools but retains stored data. Clearing summaries removes the derived cache; original conversations remain searchable. Deleting a thread removes its searchable messages and summary but retains independent saved notes. Notes associated with a deleted project remain manageable in Settings as “Unavailable project”; they are never promoted to workspace scope automatically.

## Persistence and concurrency

Preferences live in `~/.freelm/config.json`; notes and per-thread summaries live in `~/.freelm/workspace.json`, alongside other workspace records. Existing profiles load without a forced migration or rewrite. Remote workspaces keep their memories on their own FreeLM instance and use the existing revision-checked workspace writer. A concurrent remote writer can produce the same workspace conflict/recovery flow as other edits. Memory changes never write around that authority.

Remote memory requires a host that advertises Chat memory support. Older instances continue to support ordinary Chat with memory disabled; Settings explains that the host needs an update. The remote client rejects memory writes to an unsupported host instead of acknowledging fields its older storage format would discard.

The model receives relevant stored content through the selected API as part of the system context or tool results. Disabling both settings returns Chat to the memory-free request path. Deleting a saved note does not erase historical messages or tool results already present in an existing conversation.

## Research informing this implementation

These sources inform the approach; FreeLM does not depend on their SDKs or reproduce proprietary product internals.

- [OpenAI session-memory cookbook](https://developers.openai.com/cookbook/examples/agents_sdk/session_memory) distinguishes trimming from summarization and describes the retention, latency and fidelity tradeoffs of compact summaries.
- [OpenAI agent sandbox memory](https://developers.openai.com/api/docs/guides/agents/sandboxes) describes compact injected summaries followed by more detailed retrieval. FreeLM applies that progressive-disclosure pattern to document tools rather than exposing files to Chat.
- [Anthropic memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool) supports application-owned execution and virtual paths mapped to storage keys. FreeLM uses explicit note IDs and revisions instead.
- [Anthropic context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) separates compaction from durable notes and highlights the loss of detail in compressed context.
- [LangGraph memory concepts](https://docs.langchain.com/oss/python/concepts/memory) describe scoped JSON documents and the tradeoff between writes during a response and background memory formation.
- [Letta memory blocks](https://docs.letta.com/v1-sdk/memory/memory-blocks) describe bounded editable content kept in the prompt. FreeLM combines bounded saved-note injection with search/read tools when the collection is larger.
