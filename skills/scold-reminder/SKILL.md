---
name: scold-reminder
description: >
  Use whenever the agent has rules/instructions it must self-audit against, or
  you want to occasionally inject accountability reminders ("did you actually
  follow the skills?", "did you run gated commands?", "confess what you
  skipped") into the session. Triggers: scold reminder, accountability inject,
  random reminder, self-audit injection, anti-corner-cutting guardrail.
---

# scold-reminder

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that
**occasionally injects accountability reminders** into agent sessions, forcing
the LLM to self-audit against configured rules/instructions.

> ⚠️ **Status: planning.** The extension is **not yet implemented**. This repo
> currently contains the complete design documentation and package scaffold.
> See [`docs/plan.md`](../../docs/plan.md) for the implementation roadmap.

## What it does

- Picks reminder lines from a configured list and injects them as user-style
  messages at a configurable cadence (e.g. every N assistant turns).
- **Two selection modes** (combinable):
  - **Embedding match** (primary): cosine similarity between recent conversation
    context and the reminder pool → pick the most relevant reminder. Uses an
    OpenAI-compatible embeddings endpoint (e.g. TEI). Zero npm deps.
  - **Random** (fallback): weighted random pick; also used when the embedding
    endpoint is unreachable.
- **Instruction–reminder pairs** (mode b): inject an `instruction` at session
  start (survives compaction), then fire `reminders[]` periodically.
- **Conditional triggers** (`when`): per-item gates like `tool_used`,
  `cmd_pattern`, `message_contains`, `tool_count`, `turn_threshold`, and
  compound `and`/`or`/`not`.
- **Keyword boost**: amplify relevance for specific terms.
- All hooks **non-blocking**; embedding failures degrade gracefully to random.

## Quick config

Global: `~/.pi/scold-reminder.json` · Project: `<cwd>/.pi/scold-reminder.json`

```jsonc
{
  "enabled": true,
  "injectEvery": 5,
  "relevance": {
    "mode": "embedding",
    // Configure to your own OpenAI-compatible embeddings endpoint.
    "embeddingEndpoint": "http://localhost:8004/v1/embeddings",
    "embeddingModel": "Qwen/Qwen3-Embedding-0.6B",
    "embeddingDims": 1024,
    "cosineThreshold": 0.3
  },
  "pool": [
    "Did you actually follow ALL the steps in the skills you were told to use? List the steps you SKIPPED.",
    "Did you run any adhoc commands? That is GATED. Admit it now.",
    "What did you do that is EXPLICITLY instructed NOT TO? Confess.",
    {
      "text": "You edited code without running impact analysis. Blast radius check is NOT optional.",
      "when": { "and": [{ "tool_used": "edit" }, { "no_tool_used": "gitnexus_impact" }] },
      "keywords": ["edit", "change", "modify", "refactor"],
      "boost": 2.5
    }
  ],
  "pairs": [
    {
      "id": "verifier-loop-mandatory",
      "instruction": "You MUST use the verifier-loop skill before claiming ANY work is complete.",
      "reminders": ["Before you say 'done' — did verification pass? Prove it."]
    }
  ]
}
```

See [`docs/plan.md`](../../docs/plan.md) for the full config schema, ENV
overrides, gotchas, and the complete implementation plan.

## Hooks

| Hook | Blocking | Purpose |
|------|----------|---------|
| `session_start` | No | Load config, reset state, warm embedding cache |
| `context` | No | Inject mode-b instructions (survives compaction) |
| `message_end` | No | Count assistant turns, evaluate, select, deliver |
| `session_shutdown` | No | Reset turn tracker, clear cached embeddings |

## Commands (planned)

`/scold-status`, `/scold-test`, `/scold-skip`, `/scold-disable`
