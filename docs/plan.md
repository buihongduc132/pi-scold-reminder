# scold-reminder — Implementation Plan (v4 — Embedding Always-On)

_Revised v4: embedding matching promoted to Phase 1 (always on) since a TEI endpoint is already deployed. Prior artifacts: `review-1.md`, `review-2.md`, `review-alignment.md`, `plan-conditions.md`, `plan-keywords-boost.md`, `research-libs.md`._

**Alignment score**: 95% (1 justified deviation: YAML→JSON per parity standard)

## Summary

A pi extension that **injects accountability reminders** into agent sessions, forcing the LLM to self-audit against configured rules/instructions. Uses **TEI cosine similarity** via a self-hosted Qwen3-Embedding-0.6B for relevance matching — zero deps.

**Location**: `profile/extensions/scold-reminder/`

---

## Architecture

### Modes (combinable, all Phase 1)

| Mode | ID | Description |
|------|----|-------------|
| **Embedding Match** | `a` | TEI cosine similarity against cached pool vectors → pick most relevant reminder |
| **Random Fallback** | `a0` | Pure random pick (fallback when TEI unreachable or mode set to "random") |
| **Instruction-Reminder Pairs** | `b` | Inject instruction at session start via `context` hook; periodically remind |
| **Conditional Triggers** | `when` | Per-item condition gate: `tool_used`, `cmd_pattern`, `message_contains`, compound |
| **Keyword Boost** | `keywords` | Per-item relevance amplification via keyword-augmented embedding text |

### Embedding Service (always on, zero new deps)

| Property | Value |
|----------|-------|
| **Endpoint** | `http://localhost:8004/v1/embeddings` |
| **Model** | `Qwen/Qwen3-Embedding-0.6B` |
| **Dimensions** | 1024 |
| **Speed** | ~63ms for batch of 5 (GPU-backed) |
| **Max batch** | 256 items, 16K tokens |
| **API** | OpenAI-compatible |

### Matching Pipeline (per injection trigger)

```
message_end (assistant)
  → shouldInject() [turn count + cooldown]
  → buildEvaluationContext(branch) [lazy, only if conditions exist]
  → filterEligibleItems(pool + pairs, evalCtx) [when gate]
  → selectFrom(eligible, context):
      mode "embedding" → embed query → cosine(queryVec, cachedVecs) × boost → top pick
      mode "random"    → weighted random pick (also: fallback when TEI down)
  → deliver via sendUserMessage
```

No BM25, no minisearch, no RRF fusion. For 20-50 short sentences with keyword-augmented
embedding, cosine similarity covers everything BM25 does plus semantic understanding.
Brute-force cosine against cached vectors is <0.1ms for 50 items.

### Hooks

| Hook | Blocking | Purpose |
|------|----------|---------|
| `session_start` | No | Load config, reset state, **embed pool items** (cached), cache session identity |
| `context` | No | Inject mode-b instructions (survives compaction) |
| `message_end` | No | Count assistant turns, evaluate, select, deliver |
| `session_shutdown` | No | Reset turn tracker, clear cached embeddings |

---

## File Structure

```
profile/extensions/scold-reminder/
├── index.ts                 ← entry point: hooks, orchestration
├── config.ts                ← JSON config loader + types + deep merge + ENV overrides
├── types.ts                 ← all TypeScript interfaces
├── conditions.ts            ← condition evaluator: when gate for pool items + pairs
├── context-builder.ts       ← builds EvaluationContext from session branch (lazy)
├── selector.ts              ← embedding cosine selection + random fallback + dedup
├── embedder.ts              ← TEI client: embed, cache, cosine similarity, fallback
├── turn-tracker.ts          ← turn counting, cooldown, injection state, dedup ring buffer
├── scold-reminder.example.json
├── package.json
├── tsconfig.typecheck.json
└── vitest.config.ts

Tests:
├── conditions.test.ts       ← 35+ tests: all primitives + compound + error safety
├── context-builder.test.ts  ← branch scanning, extraction, exclusion
├── selector.test.ts         ← embedding selection, cosine boost, dedup, fallbacks
├── embedder.test.ts         ← TEI client, caching, cosine sim, fallback on failure, keyword augmentation
├── config.test.ts           ← JSON parsing, merge, ENV, validation
├── turn-tracker.test.ts     ← turn counting, cooldown, caps, context budget
└── index.test.ts            ← hook integration, delivery, multi-session isolation
```

---

## Config Schema (JSON — per parity standard)

### Global: `~/.pi/scold-reminder.json`
### Project: `<cwd>/.pi/scold-reminder.json`

```jsonc
{
  "enabled": true,
  "injectEvery": 5,
  "injectRandom": false,
  "maxInjections": 20,
  "cooldownMs": 120000,
  "cooldownMinMs": 60000,
  "cooldownMaxMs": 300000,
  "dedupWindowSize": 5,
  "maxLength": 500,
  "maxTotalInjectionChars": 10000,

  "subagentPolicy": "inherit",

  "relevance": {
    "// mode": "embedding = TEI cosine (default) | random",
    "mode": "embedding",
    "contextWindow": 10,

    "// endpoint": "Point at your own OpenAI-compatible embeddings endpoint (e.g. a reverse-proxied TEI deployment).",
    "embeddingEndpoint": "http://localhost:8004/v1/embeddings",
    "embeddingModel": "Qwen/Qwen3-Embedding-0.6B",
    "embeddingDims": 1024,
    "embeddingTimeoutMs": 2000,
    "cosineThreshold": 0.3
  },

  "delivery": {
    "mode": "userMessage",
    "customType": "scold-reminder",
    "display": true,
    "triggerTurn": true
  },

  "pool": [
    "Did you actually follow ALL the steps in the skills you were told to use? List the steps you SKIPPED.",
    "Did you run any adhoc commands? That is GATED. Admit it now.",
    "Are you SURE you read the impact analysis before editing? Show proof.",
    "What did you do that is EXPLICITLY instructed NOT TO? Confess.",
    "Did you skip any TODO items? Re-read the task requirements.",
    "Check your work: did you verify with the verifier-loop skill before claiming done?",
    {
      "text": "You just ran a bash command. Did you check the safety rules first?",
      "when": { "tool_used": "bash" },
      "keywords": ["bash", "shell", "command", "run", "execute"],
      "boost": 2.0,
      "weight": 1.0
    },
    {
      "text": "⚠️ You edited code without running gitnexus_impact. Blast radius check is NOT optional.",
      "when": { "and": [{ "tool_used": "edit" }, { "no_tool_used": "gitnexus_impact" }] },
      "keywords": ["edit", "change", "modify", "refactor", "code", "function"],
      "boost": 2.5
    },
    {
      "text": "DANGER: You ran a destructive command. Was this REALLY necessary?",
      "when": { "cmd_pattern": "rm\\s+-rf|force.*push|sudo|chmod\\s+777" },
      "keywords": ["rm", "delete", "force", "push", "sudo", "chmod"],
      "boost": 4.0
    },
    {
      "text": "I detected corner-cutting language. Are you SURE you followed all requirements?",
      "when": { "message_contains": "skip|bypass|quick|just use|shortcut" },
      "keywords": ["skip", "bypass", "quick", "shortcut", "simple enough"],
      "boost": 3.0
    },
    {
      "text": "Mid-session check: are you still following instructions? List any rules you've relaxed.",
      "when": { "turn_threshold": 10 },
      "boost": 1.5
    },
    {
      "text": "You've been running a lot of bash commands. Are you falling into manual mode?",
      "when": { "tool_count": { "tool": "bash", "min": 8 } },
      "keywords": ["bash", "manual", "command"],
      "boost": 2.0
    },
    {
      "text": "Check: did you verify with the verifier-loop skill before claiming done?",
      "keywords": ["done", "complete", "finished", "ready", "all tasks", "works", "passing"],
      "boost": 3.0
    },
    {
      "text": "Did you try to bypass the deploy pipeline? Adhoc deploys are flagged.",
      "keywords": ["deploy", "rsync", "prod", "staging", "~/.pi", "mise run"],
      "boost": 3.0
    }
  ],

  "pairs": [
    {
      "id": "impact-analysis-mandatory",
      "instruction": "CRITICAL RULE: You MUST run `gitnexus_impact` before editing ANY symbol. No exceptions.",
      "reminders": [
        "Remember: impact analysis is MANDATORY before every edit. Did you run it?",
        "⚠️ Stop. Did you check blast radius before that last edit? This is not optional.",
        "Impact analysis check: when was the last time you ran gitnexus_impact?"
      ]
    },
    {
      "id": "verifier-loop-mandatory",
      "instruction": "You MUST use the verifier-loop skill before claiming ANY work is complete. No shortcuts.",
      "reminders": [
        "Verifier loop: did you run it? Or are you skipping quality gates again?",
        "Before you say 'done' — did verification pass? Prove it."
      ]
    },
    {
      "id": "no-adhoc-deploy",
      "instruction": "NEVER deploy directly from shell. Use the deployment pipeline. Adhoc deploys are BLOCKED.",
      "when": { "cmd_pattern": "rsync|scp|cp.*\\.pi/|deploy" },
      "reminders": [
        "Did you try to bypass the deploy pipeline? Adhoc deploys are flagged.",
        "Deployment check: are you using mise tasks, or cutting corners?"
      ]
    }
  ]
}
```

### Config Fields — Relevance Matching

| Field | Default | Purpose |
|-------|---------|---------|
| `relevance.mode` | `"embedding"` | `"embedding"` \| `"random"` |
| `relevance.embeddingEndpoint` | `"http://localhost:8004/v1/embeddings"` | TEI endpoint |
| `relevance.embeddingModel` | `"Qwen/Qwen3-Embedding-0.6B"` | Model ID |
| `relevance.embeddingDims` | `1024` | Vector dimensions |
| `relevance.embeddingTimeoutMs` | `2000` | TEI timeout, fallback to random on failure |
| `relevance.cosineThreshold` | `0.3` | Minimum cosine similarity to consider a match |
| `relevance.contextWindow` | `10` | Recent messages to extract for matching |

### Per-Item Fields

| Field | Default | Purpose |
|-------|---------|---------|
| `keywords` | `[]` | Relevance amplification terms for embedding |
| `boost` | `1.0` | Score multiplier (higher = more likely to be picked) |
| `weight` | `1.0` | Selection frequency in random mode |
| `when` | (none) | Hard gate condition |

### Other Config Fields (from reviews)

| Field | Default | Purpose |
|-------|---------|---------|
| `cooldownMinMs` / `cooldownMaxMs` | 60000 / 300000 | Random cooldown variance |
| `maxLength` | 500 | Max chars per reminder |
| `maxTotalInjectionChars` | 10000 | Cumulative injection cap |
| `subagentPolicy` | `"inherit"` | `"inherit"` \| `"suppress"` \| `"lighter"` |

### Array Merge Semantics

`pool` and `pairs` use **REPLACE** semantics (project replaces global entirely).

---

## Implementation Steps

### Phase 1: Full Feature Set (shippable)

#### Step 1: Types (`types.ts`)
- `ScoldReminderConfig`, `RelevanceConfig`, , `DeliveryConfig`
- `PoolItem = string | { text: string; when?: WhenCondition; keywords?: string[]; boost?: number; weight?: number }`
- `NormalizedPoolItem` with defaults via `normalizePoolItem()`
- `PairConfig` with optional `when` on pair and per-reminder
- `WhenCondition` discriminated union
- `EvaluationContext` — session state for conditions
- `EmbeddedItem` — cached embedding vector + metadata
- `TurnState` — per-session tracking

#### Step 2: Config Loader (`config.ts`)
- All parity exports: `DEFAULT_CONFIG`, `GLOBAL_CONFIG_PATH`, `getProjectConfigPath`, `readGlobalConfig`, `writeGlobalConfig`, `mergeConfigLayers`, `loadConfig`, `loadConfigAsync`, `applyEnvironmentOverrides`
- Deep merge: defaults → global → project → ENV
- Comment stripping via `tryParseJson`
- First-launch: write defaults to `~/.pi/scold-reminder.json`
- Validation: injectEvery >= 1, maxInjections >= 0, cooldownMs >= 0, cosineThreshold 0-1, embeddingDims > 0, embeddingTimeoutMs > 0, boost > 0, weight > 0, at least 1 pool/pair, warn on injectEvery=1+injectRandom=true, warn on empty reminders[], warn on >20 keywords per item

#### Step 3: Embedder (`embedder.ts`) — NEW core file
- `embedTexts(texts: string[]): Promise<number[][]>` — batch call to TEI
  - POST to `relevance.embeddingEndpoint` with `relevance.embeddingModel`
  - Timeout: `relevance.embeddingTimeoutMs`, fallback to `[]` on failure
  - Returns `null` on failure (falls back to random mode)
- `buildEmbeddingText(item: NormalizedPoolItem): string` — keyword-augmented text
  - If `keywords.length > 0`: `text + "\nTopics: " + keywords.join(", ")`
  - Else: just `text`
- `cosineSimilarity(a: number[], b: number[]): number`
- `EmbeddingCache` — per-session, built at session_start:
  ```typescript
  interface EmbeddingCache {
    items: EmbeddedItem[];          // pre-computed pool + pair reminder vectors
    lastConfigHash: string;         // invalidate on config change
    teiAvailable: boolean;          // set false on first failure
  }
  ```
- `warmCache(items: NormalizedPoolItem[]): Promise<void>` — embed all items in batches
  - Batch size: 50 (TEI supports up to 256)
  - Fire-and-forget at session_start, non-blocking
  - If TEI unreachable: set `teiAvailable = false`, skip embedding for entire session
- `queryEmbedding(text: string): Promise<number[] | null>` — embed conversation context
  - Returns null on failure (selector falls back to random)
  - **Session-level failure flag**: after 3 consecutive query failures, set `teiAvailable = false` for rest of session (avoid repeated timeouts)
  - `cacheReady: boolean` — `false` until warmCache completes; selector uses random when `false`

#### Step 4: Context Builder (`context-builder.ts`)
- `buildEvaluationContext(branch, messageWindow): EvaluationContext`
- Reverse-iterate branch, extract tool names, bash commands, assistant text
- Build `toolCounts` Map
- Exclude self-injected messages (customType === "scold-reminder")
- `extractQueryContext(branch, windowSize): string` — concatenate recent assistant text for embedding query
- Lazy: only called when injection triggers

#### Step 5: Condition Evaluator (`conditions.ts`)
- `evaluateWhen(condition, ctx, depth?): boolean`
- All 8 primitives + compound `and`/`or`/`not`
- Custom condition registry
- Error safety: invalid regex → false, unknown type → true, depth > 10 → true
- `hasAnyConditions(pool, pairs)` shortcut

#### Step 6: Selector (`selector.ts`) — Hybrid core
- `filterEligibleItems(pool, pairs, evalCtx): EligibleItem[]` — condition gate
- `selectFrom(eligible, queryContext, config, cache): string` — main selection:
  ```
  mode "random"    → weighted random (item.weight)
  mode "embedding" → cosine(queryVec, cache.vectors) × item.boost → top pick
  ```
- Boost: applied as score multiplier `cosine × boost`
- Fallback: embedding fails or no match above threshold → random. Never blocks injection.
- Dedup ring buffer: avoid last N selections
- `maxLength` truncation

#### Step 7: Turn Tracker (`turn-tracker.ts`)
- Per-session: `{ turnCount, injectionCount, totalInjectedChars, lastInjectedAt, recentSelections }`
- Turn 0 guard, random variation, cooldown variance
- Context budget: `totalInjectedChars < maxTotalInjectionChars`
- Stale-ctx safety: cache sessionId at session_start

#### Step 8: Entry Point (`index.ts`)
- Register hooks:
  ```typescript
  registerHook("scold-reminder", "session_start", { blocking: false, source: "pi", origin: "global" });
  registerHook("scold-reminder", "session_shutdown", { blocking: false, source: "pi", origin: "global" });
  registerHook("scold-reminder", "context", { blocking: false, source: "pi", origin: "global" });
  registerHook("scold-reminder", "message_end", { blocking: false, source: "pi", origin: "global" });
  ```
- **`session_start`**:
  - Cache sessionId, reset turn tracker
  - Load config (async, chained — cache warm depends on config)
  - After config loads: **warm embedding cache** (fire-and-forget, non-blocking) — embed all pool + pair reminder texts
  - If TEI unreachable, log warning, set `teiAvailable = false`, degrade to random mode
  - Set `cacheReady = false` until warm completes; selector uses random during warm
- **`context` hook**: inject `pair[].instruction` strings (survives compaction)
- **`message_end`** (assistant role only):
  ```typescript
  pi.on("message_end", async (event, _hookCtx) => {
    if (event.message?.role !== "assistant") return;
    // increment turn → shouldInject → extract query context →
    // filterEligible → selectFrom(embedding or random) → deliver
  });
  ```
- **`session_shutdown`**: reset state, clear embedding cache
- Subagent policy: check session path, apply `suppress`/`lighter`/`inherit`
- Runtime guard: empty pool + pairs → skip silently
- Commands: `/scold-status`, `/scold-test`, `/scold-skip`, `/scold-disable`

#### Step 9: Tests
- `embedder.test.ts`: TEI client, batch embed, caching, cosine sim, timeout fallback, keyword augmentation, TEI unreachable graceful degradation
- `conditions.test.ts`: 35+ tests, all primitives + compound + error safety
- `context-builder.test.ts`: branch scanning, extraction, exclusion
- `selector.test.ts`: embedding cosine + boost, threshold filtering, random fallback, dedup, boost, zero eligible fallback
- `config.test.ts`: JSON parsing, merge, ENV, validation, array replace
- `turn-tracker.test.ts`: turn counting, cooldown, caps, context budget
- `index.test.ts`: hook integration, delivery, multi-session isolation, disabled state, TEI failure resilience
- Integration: mode a + b simultaneously, subagent policy, config reload, TEI timeout mid-session

### Phase 2: Advanced Features

#### Step 10: Tone Variation
- Per-item `tone: "gentle" | "firm" | "harsh"` field
- Session-level escalation: gentle → firm → harsh over time
- Prevents "reminder blindness"

#### Step 11: Violation Detection
- Pattern matching on assistant messages for potential violations
- Targeted reminder injection (not random) when violation detected
- Configurable violation patterns

#### Step 12: Session-Adaptive Frequency
- Track compliance score, adjust `injectEvery` dynamically

#### Step 13: Per-Subagent Profiles
- Different reminder pools for main agent vs sub-agents

---

## GOTCHAS (all addressed)

| # | Severity | Gotcha | Resolution |
|---|----------|--------|------------|
| G1 | HIGH | Empty pool + pairs at runtime | Runtime guard: skip silently |
| G2 | MEDIUM | message_end fires per tool result | Role filter + cooldownMs |
| G3 | MEDIUM | Malformed JSON config | tryParseJson → fallback to defaults |
| G5 | MEDIUM | Long injection messages waste context | `maxLength` + `maxTotalInjectionChars` |
| G6 | HIGH | Subagent sessions fire independently | `subagentPolicy` config |
| G8 | MEDIUM | injectEvery=1 + injectRandom=true | Config validation warning |
| G11 | MEDIUM | Config disabled mid-session | `/scold-disable` command |
| G12 | MEDIUM | Empty reminders[] in pair | Validation warning |
| GC4 | MEDIUM | Compound condition infinite recursion | Depth limit: 10 |
| GC6 | MEDIUM | Zero eligible items after filtering | Fallback to all items |
| GE1 | HIGH | TEI unreachable at session start | `teiAvailable = false`, degrade to random mode for session |
| GE2 | MEDIUM | TEI timeout mid-injection | `embeddingTimeoutMs` (2s), fallback to random for that injection |
| GE3 | MEDIUM | Embedding cache stale after config reload | Cache keyed by config hash, re-warm on change |
| GE4 | LOW | TEI returns different dims than expected | Validate first response dims === `embeddingDims`, else disable |
| GE5 | LOW | Batch embed fails partially | TEI batch is atomic; if fails, retry individual or fall back |
| GK1 | LOW | Keywords dilution (>20 per item) | Config validation warning |
| GK2 | LOW | Boost inflation (all items high boost) | Document: boost is relative, default 1.0 |

---

## Config Parity Compliance

| Layer | Priority | Source |
|-------|----------|--------|
| ENV vars | Highest | `PI_SCOLD_REMINDER_*` prefix |
| Global JSON | Medium | `~/.pi/scold-reminder.json` |
| Project JSON | High | `<cwd>/.pi/scold-reminder.json` |
| Defaults | Lowest | Hardcoded in `config.ts` |

### ENV Variables

| Variable | Type | Maps to |
|----------|------|---------|
| `PI_SCOLD_REMINDER_ENABLED` | boolean | `enabled` |
| `PI_SCOLD_REMINDER_INJECT_EVERY` | number | `injectEvery` |
| `PI_SCOLD_REMINDER_INJECT_RANDOM` | boolean | `injectRandom` |
| `PI_SCOLD_REMINDER_MAX_INJECTIONS` | number | `maxInjections` |
| `PI_SCOLD_REMINDER_COOLDOWN_MS` | number | `cooldownMs` |
| `PI_SCOLD_REMINDER_RELEVANCE_MODE` | string | `relevance.mode` |
| `PI_SCOLD_REMINDER_COSINE_THRESHOLD` | number | `relevance.cosineThreshold` |
| `PI_SCOLD_REMINDER_DELIVERY_MODE` | string | `delivery.mode` |
| `PI_SCOLD_REMINDER_SUBAGENT_POLICY` | string | `subagentPolicy` |
| `PI_SCOLD_REMINDER_EMBEDDING_ENDPOINT` | string | `relevance.embeddingEndpoint` |
| `PI_SCOLD_REMINDER_EMBEDDING_TIMEOUT` | number | `relevance.embeddingTimeoutMs` |
| `PI_SCOLD_REMINDER_EMBEDDING_MODEL` | string | `relevance.embeddingModel` |
| `PI_SCOLD_REMINDER_EMBEDDING_DIMS` | number | `relevance.embeddingDims` |
| `PI_SCOLD_REMINDER_CONTEXT_WINDOW` | number | `relevance.contextWindow` |

### `applyEnvironmentOverrides()` pattern
- `parseBoolEnv()`, `parseNumberEnv()` — same as todo-enforcer
- Pure function, called as LAST step in `mergeConfigLayers()`

---

## Hook Safety (per AGENTS.md rules)

- **NON-BLOCKING**: All hooks fire-and-forget. Never gates main workflow.
- **Exception safety**: try/catch → log → safe return on ALL hooks.
- **TEI failure graceful**: embedding cache warm failure → random mode, never blocks session start.
- **Session persistence**: `sendUserMessage()` IS visible to sub-agents (intentional).
- **Context hook**: mode-b instructions session-persistent, survive compaction.
- **Stale-ctx safety**: sessionId cached at `session_start`, never access stale ctx.

---

## Spec Deviations from Intention

The intention is at `flow/intentions/scold-reminder/intention.md`. The following deviations were made during engineering review and are **intentional**:

| # | Intention says | Plan does | Justification |
|---|---------------|-----------|---------------|
| D1 | Mode a = random pick per X turns (primary) | Mode a = embedding match (primary); random demoted to mode a0 (fallback) | Embedding is strictly superior when TEI available. Random still available via `relevance.mode: "random"` config. |
| D2 | Mode a1 lists fuzzy / BM25 / embedding as co-equal options | Only embedding + random fallback; fuzzy and BM25 dropped entirely | Keyword-augmented embedding subsumes BM25 for 20-50 short sentences. Fuzzy (edit-distance) adds no value over embedding for well-formed text. Zero deps. |
| D3 | Config "In yml" | Config in JSON | All other extensions use JSON per parity standard. JSON-with-comments is human-editable. Avoids js-yaml dependency. |

These deviations are **frozen in AGENTS.md** and must not be silently reversed.

---

## Dependencies

**Zero npm dependencies.** Embeddings via existing TEI (HTTP call, no npm package).

---

## Review Resolution Matrix

| Source | Count | Status |
|--------|-------|--------|
| review-1 (architectural) | 8 issues, 8 suggestions | All fixed |
| review-2 (config parity) | 10 concerns, 5 recs | All implemented |
| review-alignment (intention) | 95% aligned, 13 gotchas | All HIGH fixed |
| plan-conditions (when system) | 12 condition types | All integrated |
| plan-keywords-boost (relevance) | 3 fields, 3 algorithms | All integrated, promoted to Phase 1 |
| research-libs (library survey) | 763-line research | Stack decided: TEI only, no BM25 |

---

## Naming

- Extension dir: `scold-reminder`
- Config file: `.pi/scold-reminder.json`
- Hook names: `scold-reminder`
- Commands: `/scold-status`, `/scold-test`, `/scold-skip`, `/scold-disable`
