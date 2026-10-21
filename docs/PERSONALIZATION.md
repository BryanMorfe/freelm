# Personalization and system prompts

FreeLM has independent Chat and Code personalization profiles. These are provider-agnostic instructions sent with the request; they do not depend on a particular model provider or reproduce ChatGPT’s proprietary system prompt.

In Settings → Personal → Personalization, select Chat or Code and configure:

- **Personality:** Default, Friendly, Professional, Candid, Quirky, Efficient, Nerdy or Cynical.
- **Characteristics:** less, default or more warmth, enthusiasm, response length, formatting and emojis.
- **Custom instructions:** up to 10,000 characters for that mode.

Both modes start with balanced defaults. Chat remains independent of the machine: it has no local file or command access. Code adds practical collaboration and verification guidance, using only tools actually available and authorized for the task. Choosing a personality never enables tools, changes permissions or replaces correctness requirements.

Settings dropdowns use the same `src/components/Select.tsx` component as the rest of FreeLM. It supplies chevron spacing, themed popup menus, selected-option marks and keyboard navigation. `npm run build` checks JSX with the TypeScript parser and rejects native `<select>` elements in `src`; use the shared component for future dropdowns as well.

## How the guidance works

`src/lib/personalization.ts` generates the formal FreeLM identity, truthful capability and result reporting rules, selected personality, and explicit guidance for each characteristic. Nonempty custom instructions appear in a separate final block within that personalization section, retaining the original text. Reading a missing or partial legacy profile supplies defaults without changing the stored state.

The presets describe voice rather than model capability. Friendly encourages warmth without flattery; Professional favors composed precision; Candid favors constructive directness; Quirky permits appropriate playfulness; Efficient prioritizes useful brevity; Nerdy encourages curiosity and explanations at the user’s level; Cynical allows restrained dry humor and skepticism without belittling the user. Default stays clear, thoughtful and approachable. Explicit user requests for tone, detail or format take precedence over these presentation defaults.

The characteristic controls are prompt guidance, not output filters. Less formatting avoids decorative structure while retaining useful code blocks, equations, tables and requested formats. Fewer emojis avoids decoration while preserving literal quotes, code, data and explicitly requested emojis. More warmth or enthusiasm does not request flattery, exaggerated certainty or excessive praise. Shorter responses still include detail needed to finish the task correctly.

## Transparent request assembly

`src/lib/system-prompt.ts` is the shared assembler for live requests and the Settings preview. It combines personalization with additional workspace instructions, the selected project’s instructions, actual capability guidance, applicable image and web guidance, Chat memory context, and Code tool availability notes. Sections are included only when relevant. Tool schemas remain separate from the system-prompt text.

Chat previews can derive the configured image and browsing capabilities without starting local tools. Code capability guidance depends on its actual tool catalog. A provider may add its own instructions or apply model behavior beyond FreeLM’s request; the preview shows FreeLM’s assembled prompt, not undisclosed provider-side context.

Settings → System distinguishes the current or unsaved draft preview from the last prompt actually dispatched in this app session. The last-sent snapshot is captured at the API request boundary and remains unchanged when preferences or memories change. It shows the actual API function schemas, including normalized names and tools discovered during a run. This snapshot is kept in memory only; it does not duplicate prompts or memory content into every stored message. Auxiliary title generation and memory summarization continue to use their own narrowly scoped instructions.

Code previews require an existing task when host tools are enabled, so the catalog can include its real directories, skills and MCP guidance. Unsaved tool or image-model configuration must be saved before loading that host guidance. Preview runs are cancelled after catalog collection and never execute model tool calls. Catalog results are cached while Settings is open; Refresh prompt reloads them. A failed catalog load does not show an incomplete prompt as a complete preview.

## Storage and compatibility

Profiles are persisted in the workspace configuration at `~/.freelm/config.json`, separately from the existing shared system prompt. Chat edits do not alter Code preferences. Workspaces without personalization retain their existing configuration and use default profiles until personalization is saved. Remote FreeLM instances must advertise personalization support before accepting these settings; update an older instance to enable the feature.

## References

[OpenAI’s personalization documentation](https://learn.chatgpt.com/docs/personalize) distinguishes communication style from capabilities and describes custom instructions as a separate preference mechanism. FreeLM’s eight presets are its own options; the available ChatGPT controls can differ by product and platform.

[OpenAI’s personality and collaboration guidance](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.5) separates how an assistant sounds from how it works, and recommends concise instructions that complement clear goals and tool rules. FreeLM follows that distinction: shared presentation controls coexist with Code’s task collaboration guidance and the actual capability catalog.
