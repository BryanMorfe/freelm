# Code instructions and context

FreeLM builds Code requests from independent behavior, presentation, capability and context layers. The same builder powers live requests and Settings → System. They are provider-neutral: no assumed Codex identity, model family, tools or OS sandbox.

## Application instructions

- `src/lib/personalization.ts` supplies identity and the user's Chat/Code personality, style and custom instructions.
- `src/lib/code-behavior.ts` defines Code task ownership, follow-up steering, exploration, planning, edit preservation, proportional verification, reviews, compaction continuity and handoffs. Explicit Plan mode and host permissions retain precedence.
- `src/lib/system-prompt.ts` assembles behavior, goals/mode, workspace customization and available capability guidance. `electron/agent-host.ts` supplies host-derived tools and permission policy. Shared plugin/Python guidance is included once.

Code should finish authorized work without inventing turn limits or repeatedly requesting already-granted permission. Questions and reviews remain questions and reviews; these defaults do not authorize implementation or change the selected permission mode. Workflow Agent nodes retain their node instructions and tool allowlists.

## Source-labelled context

Code project instructions, discovered repository instructions, loaded `MEMORY.md` content and selected composer references are sent separately as user-role context. Their source paths or labels remain visible. Workspace/personality custom instructions remain intentional application-prompt customization. Chat's existing prompt behavior is unchanged.

Responses receives application policy in `instructions` and supplied context as a user input message. Chat Completions uses the existing system message and a user context message. This avoids requiring a provider-specific developer role. Source labels describe provenance and scope; host permissions continue to enforce access.

The context prefix counts toward the context budget and survives compaction and explicit resets. It is not persisted into conversation transcripts, so a new run replaces it with current source snapshots. During an active run it is a snapshot; an agent editing instructions should reread them using the available tools. Settings' Refresh prompt reloads host context; Last sent preserves the actual request snapshot. Copying includes both displayed layers.

## Repository instructions

Discovery runs on the execution host, including remotes. Each selected project folder (or configured default workspace) is a boundary. Within a boundary, discovery reads the root-to-initial-working-directory path. Without an explicit boundary it uses the nearest `.git` directory/file, or only the working directory when none exists. It does not recursively scan unrelated directories or load arbitrary ancestor instructions.

`AGENTS.override.md` replaces `AGENTS.md` in the same directory, including an intentionally empty override. Each file governs its directory and descendants; deeper instructions take precedence within their scope. The agent must check applicable nested files before editing elsewhere. Repository instructions cannot grant permissions or override the user request or host rules.

Automatic reads share a 32 KiB content budget. Omitted/truncated or unreadable files produce notices directing the agent to read complete applicable files through available tools. This budget does not limit further investigation. Automatic loading rejects symlinked/nonregular and invalid text files; it does not disable normal file tools.

## Reference and validation

Informed by public Codex CLI commit `8c076942cb70fba8e5c4732c23f1faabc4aed484` (2026-10-18): [model instructions](https://github.com/openai/codex/blob/8c076942cb70fba8e5c4732c23f1faabc4aed484/codex-rs/models-manager/models.json), [repository discovery](https://github.com/openai/codex/blob/8c076942cb70fba8e5c4732c23f1faabc4aed484/codex-rs/core/src/agents_md.rs), and [instruction precedence](https://github.com/openai/codex/blob/8c076942cb70fba8e5c4732c23f1faabc4aed484/codex-rs/core/src/session/mod.rs#L801). FreeLM retains its tools, personalization, approval policies and provider compatibility.

Relevant checks cover filesystem discovery, project/Chat isolation, both provider request shapes, compaction/resume, remote transport, workflow Agent propagation and Settings preview/snapshots. Deterministic providers verify request construction and runtime behavior; they do not establish how a particular model follows the instructions.
