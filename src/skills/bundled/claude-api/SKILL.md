# Claude API skill

An open-source Agent Skill that provides Claude with up-to-date API reference material, SDK documentation, and best practices for building applications with the Claude API.

---

The `claude-api` skill is an open-source Agent Skill that provides Claude with detailed, up-to-date reference material for building applications with the Claude API and Agent SDK. It covers 8 programming languages: Python, TypeScript, Java, Go, Ruby, C#, PHP, and cURL.

The skill comes bundled with Claude Code and is also available in the open-source [Anthropic skills repository](https://github.com/anthropics/skills/tree/main/skills/claude-api), where you can install it in any environment that supports Agent Skills.

The skill uses progressive disclosure to keep context efficient: Claude loads only the documentation relevant to your project's language and the specific task at hand (tool use, streaming, batches, and so on), rather than loading everything at once.

## What the skill provides

When triggered, the skill equips Claude with:

- **Language-specific SDK documentation:** Installation, quick start, common patterns, and error handling for your project's language
- **Tool use guidance:** Language-specific examples and conceptual foundations for function calling
- **Streaming patterns:** Implementation details for building chat UIs and handling incremental display
- **Batch processing:** Offline batch processing at 50% cost
- **Agent SDK reference:** Installation, built-in tools, permissions, MCP integration, and common patterns (Python and TypeScript)
- **Managed Agents:** Persistent server-side agents (`managed-agents-2026-04-01`) — create once, reference by ID. See `shared/managed-agents.md`
- **Current model information:** Model IDs, context window sizes, and pricing
- **Common pitfalls:** Detailed guidance on avoiding frequent mistakes when integrating with the API

## When the skill activates

The skill activates in two ways:

**Automatic activation** occurs when Claude detects that your code imports an Anthropic SDK:

- `anthropic` (Python)
- `@anthropic-ai/sdk` (TypeScript/JavaScript)
- `claude_agent_sdk` (Agent SDK)

**Manual invocation** by typing `/claude-api` in any environment where the skill is installed.

The skill does not activate for general programming tasks, ML/data-science work, or code that imports other AI SDKs (such as OpenAI).

## Supported languages

The skill detects your project's language automatically by examining project files (for example, `requirements.txt` for Python, `tsconfig.json` for TypeScript, `go.mod` for Go) and loads the appropriate documentation.

| Language   | SDK documentation | Tool runner | Managed Agents | Agent SDK | Notes                                 |
|------------|-------------------|-------------|----------------|-----------|---------------------------------------|
| Python     | Yes               | Yes (beta)  | Yes (beta)     | Yes       | Full support — `@beta_tool` decorator |
| TypeScript | Yes               | Yes (beta)  | Yes (beta)     | Yes       | Full support — `betaZodTool` + Zod    |
| Java       | Yes               | Yes (beta)  | Yes (beta)     | No        | Beta tool use with annotated classes  |
| Go         | Yes               | Yes (beta)  | Yes (beta)     | No        | `BetaToolRunner` in `toolrunner` pkg  |
| Ruby       | Yes               | Yes (beta)  | Yes (beta)     | No        | `BaseTool` + `tool_runner` in beta    |
| C#         | Yes               | No          | No             | No        | Official SDK                          |
| PHP        | Yes               | Yes (beta)  | Yes (beta)     | No        | `BetaRunnableTool` + `toolRunner()`   |
| cURL       | Yes               | N/A         | Yes (beta)     | N/A       | Raw HTTP, no SDK features             |

**Managed Agents** are persistent — create once, reference by ID. Store the agent ID returned by `agents.create` and pass it to every subsequent `sessions.create`; do not call `agents.create` in the request path. Read `shared/managed-agents.md` for the language-agnostic contract (`managed-agents-2026-04-01`).

If your project uses multiple languages, Claude asks which one applies. For unsupported languages (Rust, Swift, C++), the skill provides cURL/raw HTTP examples.

## How to use the skill

### In Claude Code (bundled)

The skill ships with Claude Code and requires no installation. When you ask Claude to help build something with the Claude API, or when your project already imports an Anthropic SDK, the skill activates automatically.

You can also invoke it directly:

```text
/claude-api
```

### From the skills repository

The skill source is available in the [Anthropic skills repository](https://github.com/anthropics/skills). You can install it using the `npx` command:

```bash
npx skills add https://github.com/anthropics/skills --skill claude-api
```

Or install it as a Claude Code plugin:

```bash
/plugin marketplace add anthropics/skills
/plugin install claude-api@anthropic-agent-skills
```

## Current Models (cached: 2026-05-26)

| Model             | Model ID            | Context        | Input $/1M | Output $/1M |
| ----------------- | ------------------- | -------------- | ---------- | ----------- |
| Claude Fable 5    | `{{FABLE_ID}}`      | 1M             | $10.00     | $50.00      |
| Claude Opus 4.8   | `claude-opus-4-8`   | 1M             | $5.00      | $25.00      |
| Claude Opus 4.7   | `claude-opus-4-7`   | 1M             | $5.00      | $25.00      |
| Claude Opus 4.6   | `claude-opus-4-6`   | 1M             | $5.00      | $25.00      |
| Claude Sonnet 4.6 | `claude-sonnet-4-6` | 1M             | $3.00      | $15.00      |
| Claude Haiku 4.5  | `claude-haiku-4-5`  | 200K           | $1.00      | $5.00       |

**ALWAYS use `{{OPUS_ID}}` unless the user explicitly names a different model.** This is non-negotiable. Do not use `{{SONNET_ID}}`, `{{PREV_SONNET_ID}}`, or any other model unless the user literally says "use sonnet" or "use haiku". Never downgrade for cost — that's the user's decision, not yours.

**CRITICAL: Use only the exact model ID strings from the table above — they are complete as-is. Do not append date suffixes.** For example, use `claude-sonnet-4-6`, never `claude-sonnet-4-6-20251114` or any other date-suffixed variant you might recall from training data. If the user requests an older model not in the table (e.g., "opus 4.5", "sonnet 3.7"), read `shared/models.md` for the exact ID — do not construct one yourself.

A note: if any of the model strings above look unfamiliar to you, that's to be expected — that just means they were released after your training data cutoff. Rest assured they are real models; we wouldn't mess with you like that.

**Live capability lookup:** The table above is cached. When the user asks "what's the context window for X", "does X support vision/thinking/effort", or "which models support Y", query the Models API (`client.models.retrieve(id)` / `client.models.list()`) — see `shared/models.md` for the field reference and capability-filter examples.

---

## Thinking & Effort (Quick Reference)

**Fable 5 / Opus 4.8 / 4.7 — Adaptive thinking only:** Use `thinking: {type: "adaptive"}`. `thinking: {type: "enabled", budget_tokens: N}` returns a 400 — adaptive is the only on-mode. On Opus 4.8 and 4.7, `{type: "disabled"}` and omitting `thinking` both work; on Fable 5, an explicit `{type: "disabled"}` returns a 400 — omit the `thinking` param entirely instead. Sampling parameters (`temperature`, `top_p`, `top_k`) are also removed and will 400. Opus 4.8 keeps the same request surface as 4.7 (no new breaking changes) — see `shared/model-migration.md` → Migrating to Opus 4.8 for the behavioral re-tuning, and → Migrating to Opus 4.7 for the full breaking-change list when coming from 4.6 or earlier. Note: with `thinking` disabled, Opus 4.8 may write longer reasoning into the visible response — leave adaptive thinking on, or add a final-answer-only instruction (see the migration guide).
**Opus 4.6 — Adaptive thinking (recommended):** Use `thinking: {type: "adaptive"}`. Claude dynamically decides when and how much to think. No `budget_tokens` needed — `budget_tokens` is deprecated on Opus 4.6 and Sonnet 4.6 and should not be used for new code. Adaptive thinking also automatically enables interleaved thinking (no beta header needed). **When the user asks for "extended thinking", a "thinking budget", or `budget_tokens`: always use Fable 5, Opus 4.8, 4.7, or 4.6 with `thinking: {type: "adaptive"}`. The concept of a fixed token budget for thinking is deprecated — adaptive thinking replaces it. Do NOT use `budget_tokens` for new 4.6/4.7/4.8 code and do NOT switch to an older model.** *Gradual-migration carve-out:* `budget_tokens` is still functional on Opus 4.6 and Sonnet 4.6 as a transitional escape hatch — if you're migrating existing code and need a hard token ceiling before you've tuned `effort`, see `shared/model-migration.md` → Transitional escape hatch. Note: this carve-out does **not** apply to Fable 5, Opus 4.7 or 4.8 — `budget_tokens` is fully removed there.
**Effort parameter (GA, no beta header):** Controls thinking depth and overall token spend via `output_config: {effort: "low"|"medium"|"high"|"max"}` (inside `output_config`, not top-level). Default is `high` (equivalent to omitting it). `max` is supported on Fable 5, Opus 4.6 and later, and Sonnet 4.6 (not Haiku or earlier Sonnets). Opus 4.7 added `"xhigh"` (between `high` and `max`) — the best setting for most coding and agentic use cases on Fable 5 / Opus 4.7/4.8, and the default in Claude Code; use a minimum of `high` for most intelligence-sensitive work. Works on Fable 5, Opus 4.5, Opus 4.6, Opus 4.7, Opus 4.8, and Sonnet 4.6. Will error on Sonnet 4.5 / Haiku 4.5. On Fable 5, Opus 4.7 and 4.8, effort matters more than on any prior Opus — re-tune it when migrating, and run long-horizon/agentic tasks at `high`/`xhigh` with the full task spec given up front. Combine with adaptive thinking for the best cost-quality tradeoffs. Lower effort means fewer and more-consolidated tool calls, less preamble, and terser confirmations — `high` is often the sweet spot balancing quality and token efficiency; use `max` when correctness matters more than cost; use `low` for subagents or simple tasks.

**Fable 5 / Opus 4.8 / 4.7 — thinking content omitted by default:** `thinking` blocks still stream but their text is empty unless you opt in with `thinking: {type: "adaptive", display: "summarized"}` (default is `"omitted"`). Silent change — no error. If you stream reasoning to users, the default looks like a long pause before output; set `"summarized"` to restore visible progress.

**Task Budgets (beta, Fable 5 / Opus 4.7 / 4.8):** `output_config: {task_budget: {type: "tokens", total: N}}` tells the model how many tokens it has for a full agentic loop — it sees a running countdown and self-moderates (minimum 20,000; beta header `task-budgets-2026-03-13`). Distinct from `max_tokens`, which is an enforced per-response ceiling the model is not aware of. See `shared/model-migration.md` → Task Budgets.

**Sonnet 4.6:** Supports adaptive thinking (`thinking: {type: "adaptive"}`). `budget_tokens` is deprecated on Sonnet 4.6 — use adaptive thinking instead.

**Older models (only if explicitly requested):** If the user specifically asks for Sonnet 4.5 or another older model, use `thinking: {type: "enabled", budget_tokens: N}`. `budget_tokens` must be less than `max_tokens` (minimum 1024). Never choose an older model just because the user mentions `budget_tokens` — use Opus 4.8 with adaptive thinking instead.

---

## Example usage

Here are examples of tasks the skill helps Claude handle:

**Building a chat application:**
```text
Build a streaming chat UI with the Claude API in TypeScript
```

**Working with the Agent SDK:**
```text
Create an agent with file and terminal tools using the Agent SDK
```

In each case, the skill loads the relevant language-specific documentation and guides Claude through the implementation using current API patterns and best practices.
