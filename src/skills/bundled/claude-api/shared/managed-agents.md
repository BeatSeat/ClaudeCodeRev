# Managed Agents

Persistent server-side agents under the `managed-agents-2026-04-01` beta. Send `anthropic-beta: managed-agents-2026-04-01` on every request.

**Agents are persistent — create once, reference by ID.** Store the agent ID returned by `agents.create` and pass it to every subsequent `sessions.create`; do not call `agents.create` in the request path.

## Contract

There is no inline agent config. Under `managed-agents-2026-04-01`, `model` / `system` / `tools` are top-level fields on `POST /v1/agents`, not on the session. Always create the agent first — the session only takes `"agent": {"type": "agent", "id": "..."}`.

Typical flow:

1. `POST /v1/environments` — cloud environment (optional networking restrictions)
2. `POST /v1/agents` — name, model, tools (for example `{ "type": "agent_toolset_20260401" }`)
3. `POST /v1/sessions` — `{ "agent": { "type": "agent", "id": "agent_..." }, "environment_id": "env_..." }`

If you need a class, method, namespace, field, or behavior that isn't shown here, WebFetch the relevant SDK repo or docs page from `shared/live-sources.md` rather than guess. Do not extrapolate from cURL shapes or another language's SDK.
