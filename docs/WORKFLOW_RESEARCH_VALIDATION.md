# Research workflow validation — October 17, 2026

## Scope

This validates the reusable Feedback loop, Shared collection, and structured Agent/Text output capabilities, plus the Research team and Co-Scientist templates. It does not validate the scientific claims made by the research agents.

The live trial asks: **How can a local multi-agent system reduce inference latency while preserving answer quality?** All seven configured Agent nodes use the existing Local Workstation connection, `qwen3.8-27b`, and its Medium thinking mode. The Co-Scientist parent requests two rounds, with generation, proximity/grouping, review, pairwise ranking, refinement, and meta-review in each round, followed by a report. Automatic triggers remain disabled.

## Implementation checks

- 39 engine, feedback, and collection tests passed, including cancellation during child admission, restart recovery, retry without replaying completed rounds, parallel-child recovery, root isolation, and revision checks.
- 128 Agent, adapter, and structured-output tests passed. These cover provider schema formatting, final-output validation, and tool-free correction requests.
- Four research-template tests passed, including the actual template Code transforms across two rounds, deterministic ratings, source preservation, separate investigations, and model-context deduplication.
- Six workflow browser scenarios passed across the suite and focused reruns. The template-creation scenario passed again after the context fix. Checks include structured-output controls, shared records, feedback progress, and template persistence.
- The native fixture passed in compiled and signed packaged FreeLM: selected tool dispatch, strict JSON output, format correction, two sequential rounds, shared records, and recovery without replay.
- The final build passed TypeScript and production bundling. The universal macOS package passed deep, strict signature verification. Its installed archive matches the packaged archive.

These are focused feature checks, not a claim that the entire repository test suite is green.

## Live diagnostic and correction

The first live run, `19cb6aaf-12a1-4d13-b7e7-8a5914143255`, completed its first round and passed the resulting state into the second. Inspection revealed that the template forwarded repeated aliases of the state and full history to the model, producing roughly 265,000 characters of duplicated context. The run was cancelled and retained as **Co-Scientist · Context diagnostic**.

The templates now use ordinary Code nodes to prepare model context. The current state appears once, older history becomes at most eight compact summaries, and the current round is excluded from those summaries. The editable budget is 96,000 characters. Complete records remain in the shared collection and investigation-records output. No model context-window or thinking settings were changed.

## Corrected live run

Run `ee39d1f7-f83f-46a3-b05c-dc15f7b48429` was started through the installed, signed app and completed in **10 minutes 11.656 seconds**. The UI showed **Run completed — 9 / 9 completed**. Both child rounds completed all 13 of their nodes.

- Round one: `71e5c434-0f17-4895-bccb-b33c42ab6c71`, 4 minutes 36.310 seconds.
- Round two: `536c84c1-6775-42dd-96a4-5e243484fcb9`, 5 minutes 2.498 seconds.
- All **13 Agent executions** used Qwen3.8 27B Medium and independently passed their saved JSON schemas on the first validation attempt.
- Round two's input state exactly equalled round one's result. Both records were saved once, with revision 1 and the correct writer provenance, under the same root investigation scope.
- Prepared context was 225 bytes for round one, 29,504 bytes for round two, and 36,097 bytes for the report. The report received the final state once and one compact older-round summary.
- The final named output was a 5,895-byte Markdown report, alongside two complete investigation records.
- All **19 mechanical audit checks** passed.

The installed archive SHA-256 is `574299065dbddf95d7835cb065fdb3c11cafe0b8afcc3541c3bd62e0fb451147`. Its native main bundle matches the bundle exercised by the signed fixture test; the corrected research templates are included in this final renderer build.

Workflow definitions:

- Parent: `c2d1f75c-fbf6-4d30-b82f-2e2130a72091`
- Research round: `bfea34c9-df69-4bc1-8da8-8abb52d1dbc9`

The audit independently checks saved status, exact feedback handoff, root scope IDs, collection records and provenance, schema validity, model configuration, prepared context size, recorded tool use, and the final Markdown output. Provider success alone is not considered proof that citations were retrieved or that proposed experiments were performed.

## Research-quality limitation

**No successful tool calls were recorded**, even though generation and review had `web.run` selected. The final report contains four source entries, but this run does not establish that those sources were retrieved or that they support the accompanying claims. Its hardware assumptions, numerical estimates, literature-gap claims, and proposed experiments remain unverified. No experiments were executed.

This is a successful orchestration and structured-output trial. Evidence retrieval and citation verification need separate evaluation before using its proposals as a research result.

- [Generated proposal, with the verification caveat](examples/co-scientist-local-inference-report.md)
- [Read-only execution audit](examples/co-scientist-local-inference-audit.json)
