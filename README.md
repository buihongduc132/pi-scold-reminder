# pi-scold-reminder

> A [pi](https://github.com/earendil-works/pi-coding-agent) extension that
> occasionally injects accountability reminders into agent sessions, forcing
> the LLM to self-audit against configured rules/instructions.

[![CI](https://github.com/buihongduc132/pi-scold-reminder/actions/workflows/ci.yml/badge.svg)](https://github.com/buihongduc132/pi-scold-reminder/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> ⚠️ **Status: planning (v0.0.1).** The extension itself is **not yet
> implemented** — this repository currently contains the **complete design
> documentation** and a **package scaffold** ready for Phase 1 implementation.
> See [`docs/plan.md`](docs/plan.md) for the full roadmap.

---

## Why

Agents routinely skip steps that are in their instruction prompt: they run
gated commands adhoc, claim "done" without verification, edit code without
checking blast radius, and quietly relax rules mid-session. **scold-reminder**
addresses this with a bit of non-deterministic friction: it picks reminder
lines from a configured list and injects them as user-style messages at a
configurable cadence — acting like a human *demanding* the agent align with
the requirements.

A little randomized pressure beats zero enforcement.

## How it works

```
message_end (assistant)
  → shouldInject() [turn count + cooldown]
  → buildEvaluationContext(branch) [lazy, only if conditions exist]
  → filterEligibleItems(pool + pairs, evalCtx) [when gate]
  → selectFrom(eligible, context):
      mode "embedding" → embed query → cosine(queryVec, cachedVecs) × boost → top pick
      mode "random"    → weighted random pick (also: fallback when embeddings down)
  → deliver via sendUserMessage
```

### Modes (combinable)

| Mode | ID | Description |
|------|----|-------------|
| **Embedding Match** | `a` | Cosine similarity between recent context and the reminder pool |
| **Random Fallback** | `a0` | Pure random pick (fallback when endpoint unreachable, or via config) |
| **Instruction-Reminder Pairs** | `b` | Inject instruction at session start; remind periodically |
| **Conditional Triggers** | `when` | Per-item gate: `tool_used`, `cmd_pattern`, `message_contains`, … |
| **Keyword Boost** | `keywords` | Per-item relevance amplification |

**Zero npm dependencies.** Embeddings are fetched over HTTP from any
OpenAI-compatible embeddings endpoint (e.g. [Text Embeddings Inference
(TEI)](https://github.com/huggingface/text-embeddings-inference)).

## Installation (once implemented)

```bash
pi install github:buihongduc132/pi-scold-reminder
```

Or add to your pi `settings.json` `packages[]`:

```jsonc
{ "source": "github:buihongduc132/pi-scold-reminder" }
```

## Configuration

- Global: `~/.pi/scold-reminder.json`
- Project: `<cwd>/.pi/scold-reminder.json`
- ENV prefix: `PI_SCOLD_REMINDER_*`

See [`skills/scold-reminder/SKILL.md`](skills/scold-reminder/SKILL.md) for a
quick example and [`docs/plan.md`](docs/plan.md) for the full schema.

## Repository layout

```
pi-scold-reminder/
├── docs/                     ← complete design documentation (intention, plan, reviews)
├── extensions/               ← extension entry (NOT YET IMPLEMENTED — placeholder)
├── skills/scold-reminder/    ← pi skill manifest
├── scripts/smoke-test.ts     ← structural smoke test
├── .github/workflows/ci.yml  ← typecheck + test + smoke
└── package.json
```

## Roadmap

- **Phase 1** (shippable): embedding match + random fallback + instruction/reminder
  pairs + conditional triggers + keyword boost. Full file structure in
  [`docs/plan.md`](docs/plan.md).
- **Phase 2**: tone variation (gentle → firm → harsh escalation), violation
  detection, session-adaptive frequency, per-subagent profiles.

## License

[MIT](LICENSE) © buihongduc132
