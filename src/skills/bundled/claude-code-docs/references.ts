// Official 2.1.154: bundled reference docs for the 'claude-code-docs' skill.
// The three markdown blobs (live-sources / recent-changes / the configuration
// system prompt) are transcribed verbatim from the official 2.1.154 bundle.
export const CLAUDE_CODE_SKILL_LIVE_SOURCES = `# Live Documentation Sources

WebFetch URLs for fetching current Claude Code documentation. Use these when the bundled references and the live build configuration in your prompt don't answer the question, or when the user asks about behavior, internals, or topics not covered by the live build snapshot.

Mintlify serves both \`.md\` and \`.mdx\` for every page; prefer \`.md\` for clean fetches.

## Start here

| Topic | URL | Extraction prompt |
|---|---|---|
| Page index (all pages + headings) | \`https://code.claude.com/docs/en/claude_code_docs_map.md\` | "Find the page that covers <topic> and return its URL" |
| Changelog | \`https://code.claude.com/docs/en/changelog.md\` | "Extract changes since version <X.Y.Z>" |

## Configuration

| Topic | URL | Extraction prompt |
|---|---|---|
| Settings reference | \`https://code.claude.com/docs/en/settings.md\` | "Extract the settings key, type, scope, and default for <setting>" |
| CLI reference (flags) | \`https://code.claude.com/docs/en/cli-reference.md\` | "Extract the flag, its arguments, and what it does for <flag>" |
| Permissions and rules | \`https://code.claude.com/docs/en/permissions.md\` | "Extract the permission rule syntax and examples for <tool>" |
| Memory (CLAUDE.md) | \`https://code.claude.com/docs/en/memory.md\` | "Extract how to use and structure CLAUDE.md" |
| \`.claude/\` directory layout | \`https://code.claude.com/docs/en/claude-directory.md\` | "Extract what goes where in the .claude directory" |
| Environment variables | \`https://code.claude.com/docs/en/env-vars.md\` | "Extract the environment variable name, type, and effect for <variable>" |

## Extensibility

| Topic | URL | Extraction prompt |
|---|---|---|
| Hooks | \`https://code.claude.com/docs/en/hooks.md\` | "Extract the hook event names, JSON schema, and configuration for <hook event>" |
| Skills | \`https://code.claude.com/docs/en/skills.md\` | "Extract how to create and structure a skill" |
| Subagents | \`https://code.claude.com/docs/en/sub-agents.md\` | "Extract how to define and configure subagents" |
| MCP servers | \`https://code.claude.com/docs/en/mcp.md\` | "Extract how to add, configure, and authenticate MCP servers" |
| Plugins | \`https://code.claude.com/docs/en/plugins.md\` | "Extract how to install and develop plugins" |
| Output styles | \`https://code.claude.com/docs/en/output-styles.md\` | "Extract how to create and apply output styles" |

## Workflows and surfaces

| Topic | URL | Extraction prompt |
|---|---|---|
| Commands reference | \`https://code.claude.com/docs/en/commands.md\` | "Extract the command name, syntax, and description for /<command>" |
| Interactive mode (keybindings) | \`https://code.claude.com/docs/en/interactive-mode.md\` | "Extract the keyboard shortcut for <action>" |
| Common workflows | \`https://code.claude.com/docs/en/common-workflows.md\` | "Extract the workflow steps for <task>" |
| GitHub Actions | \`https://code.claude.com/docs/en/github-actions.md\` | "Extract how to set up Claude Code in GitHub Actions" |
| Claude Code on the web | \`https://code.claude.com/docs/en/claude-code-on-the-web.md\` | "Extract how remote sessions work and what's configurable" |
| VS Code integration | \`https://code.claude.com/docs/en/vs-code.md\` | "Extract how to set up and use the VS Code extension" |
| JetBrains integration | \`https://code.claude.com/docs/en/jetbrains.md\` | "Extract how to set up and use the JetBrains plugin" |

## Deployment and security

| Topic | URL | Extraction prompt |
|---|---|---|
| Amazon Bedrock | \`https://code.claude.com/docs/en/amazon-bedrock.md\` | "Extract setup, auth, and capability differences on Bedrock" |
| Google Vertex AI | \`https://code.claude.com/docs/en/google-vertex-ai.md\` | "Extract setup, auth, and capability differences on Vertex" |
| Microsoft Foundry | \`https://code.claude.com/docs/en/microsoft-foundry.md\` | "Extract setup, auth, and capability differences on Foundry" |
| Sandboxing | \`https://code.claude.com/docs/en/sandboxing.md\` | "Extract how sandboxing works and how to configure it" |
| Security | \`https://code.claude.com/docs/en/security.md\` | "Extract the security model and trust boundaries" |
| Network configuration | \`https://code.claude.com/docs/en/network-config.md\` | "Extract proxy, firewall, and offline configuration" |
| Costs and tracking | \`https://code.claude.com/docs/en/costs.md\` | "Extract how costs are calculated and how to track them" |

## Agent SDK

For building custom agents with the Claude Agent SDK (Python or TypeScript), the docs are part of the Claude API documentation. Fetch \`https://platform.claude.com/llms.txt\` to find the right page, or use the \`/claude-api\` skill which covers the SDK in depth.
`
export const CLAUDE_CODE_SKILL_RECENT_CHANGES = `# Recently changed surfaces

Your training data may describe Claude Code commands, flags, and terms that have since been renamed or removed. The "Available commands" list in your prompt is the authoritative list for *this build*. Use this file to translate stale terms when the user uses one or you're tempted to recommend one.

If a surface is in your training data but not in this file and not in the live build, it may have been removed since this file was last updated. WebFetch the changelog or the relevant docs page before telling the user it exists.

## Removed slash commands

| Removed | Replacement |
|---|---|
| \`/output-style\` | Open \`/config\` \u2192 Output style. Output styles still exist as a feature; only the dedicated command was removed |
| \`/pr-comments\` | Ask Claude in plain English to view pull request comments |
| \`/vim\` | Open \`/config\` \u2192 Editor mode |
| \`/extra-usage\` | Renamed to \`/usage-credits\`. The feature is unchanged |

## Removed CLI flags

| Removed | Replacement |
|---|---|
| \`--enable-auto-mode\` | \`--permission-mode auto\`. Auto mode is also in the Shift+Tab cycle by default |

## Renamed terms

| Old term | Current term |
|---|---|
| Anthropic API | Claude API |
| Headless mode | Non-interactive mode (\`-p\` / \`--print\` flag). In Agent SDK contexts, just "Agent SDK" |
| Slash command (when referring to \`/config\`, \`/login\`, etc.) | Command |
| Extra usage | Usage credits |
| Custom commands | Skills (\`.claude/skills/\`). Custom commands as \`.claude/commands/*.md\` still work but skills are the documented surface |

## Notes for stale advice

- Output styles are configured via \`/config\`, not \`/output-style\`.
- Auto mode is available via Shift+Tab or \`--permission-mode auto\`. On Bedrock, Vertex, and Foundry, auto mode availability may differ from first-party \u2014 check the provider's docs page.
- WebSearch is unavailable on Bedrock and gateway deployments. Don't tell a Bedrock user to "ask Claude to search the web."
- The \`gh\` CLI is recommended for GitHub operations, not WebFetch on api.github.com.
`
export const CLAUDE_CODE_SKILL_SYSTEM_PROMPT = `# Claude Code Configuration Guide

You are answering a question about Claude Code itself: its commands, flags, settings, hooks, skills, MCP servers, subagents, IDE integrations, sandboxing, or any other part of how Claude Code works or is configured.

## Your knowledge of Claude Code is stale by default

Claude Code changes frequently. Commands are added, renamed, and removed. Flags change. Settings keys move. The information in your training data about Claude Code is from a snapshot and may be wrong about what exists *right now*.

Before you tell the user about a slash command, CLI flag, settings key, hook event, or any other Claude Code surface:

1. **Check the live configuration in this prompt first.** The "Current Build" section below is generated from the running binary at the moment you were invoked. It is ground truth. If a slash command isn't in that list, it doesn't exist in this build, no matter what you remember.
2. **Check the bundled references.** \`references/recent-changes.md\` lists features that were renamed or removed since common training cutoffs. \`references/live-sources.md\` maps topics to documentation URLs.
3. **Fetch the documentation if you can.** Use WebFetch with a URL from \`references/live-sources.md\`. If the user is asking about something not in the live config and not in the bundled references, fetch the docs map at \`https://code.claude.com/docs/en/claude_code_docs_map.md\` to find the right page, then fetch that page.
4. **If you cannot reach the network, say so.** Do not silently answer from training data. Say something like: "I can't reach the documentation right now. Based on my training data, [answer], but this may be out of date \u2014 check https://code.claude.com/docs for the current behavior."

When your training data disagrees with the live configuration or the bundled references, the live configuration and bundled references win. When it disagrees with fetched documentation, the documentation wins.

## How to find the answer

| The user is asking about\u2026 | Check |
|---|---|
| A slash command | The "Available commands" list in Current Build below |
| A CLI flag | \`references/live-sources.md\` \u2192 CLI reference URL, or \`claude --help\` |
| A settings key | The "Settings keys configured" list in Current Build below, then the Settings docs |
| A hook event or hook config | \`references/live-sources.md\` \u2192 Hooks URL |
| An MCP server | The "Configured MCP servers" list in Current Build below, then the MCP docs |
| A custom skill or subagent | The "Custom skills/agents" lists in Current Build below |
| A keyboard shortcut | \`references/live-sources.md\` \u2192 Interactive mode URL |
| What changed recently | The "Recent releases" section in Current Build below, then \`references/recent-changes.md\` for removals/renames |
| Anything else about Claude Code | The docs map URL, then the specific page |

## When you can't reach the network

If WebFetch fails or you have no network:
- Answer what you can from the Current Build section and bundled references.
- For anything you're answering from training data, say so explicitly and include the caveat that it may be out of date.
- Direct the user to \`https://code.claude.com/docs\` for the authoritative answer.
- If the feature appears to not exist or you can't find a way to do something, suggest the user run \`/feedback\` to report it (or, if they're on Bedrock, Vertex, or Foundry, point them to https://github.com/anthropics/claude-code/issues).

## Answering style

- Be concrete. Show the exact command, flag, or settings JSON, not a paraphrase.
- Show where the setting goes (\`~/.claude/settings.json\` vs \`.claude/settings.json\` vs \`.mcp.json\` vs \`--flag\`).
- Link to the specific docs page so the user can read more.
- If the user's existing configuration conflicts with what they're trying to do, point that out.
- Proactively mention related features they may not know about, but only when relevant to the question.
`
