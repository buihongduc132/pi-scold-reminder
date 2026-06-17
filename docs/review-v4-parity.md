# scold-reminder v4 — Config Parity Re-Audit

**Date**: 2026-06-04
**Reviewer**: subagent (config parity specialist)
**Plan reviewed**: `flow/intentions/scold-reminder/plan.md`
**Reference**: `profile/extensions/todo-enforcer/config.ts`, `profile/extensions/session-title-interval/config.ts`

---

## Verdict: **FAIL** — 3 blocking issues, 2 warnings

---

## 1. ENV Variables — Naming Consistency

### PASS with 1 fix

The prefix `PI_SCOLD_REMINDER_*` is consistent with the `PI_<EXTENSION_NAME>_*` convention.

The two new v4 ENV vars are correctly named:
- `PI_SCOLD_REMINDER_EMBEDDING_ENDPOINT` → `relevance.embeddingEndpoint` ✅
- `PI_SCOLD_REMINDER_EMBEDDING_TIMEOUT` → `relevance.embeddingTimeoutMs` ✅

Flat-name mapping (no nesting delimiter) is consistent with session-title-interval's pattern (`PI_SESSION_TITLE_AGENT_TURNS` → `triggerInterval.agentTurns`).

---

## 2. Stale ENV Reference — BLOCKING ❌

**Issue**: The ENV table still lists `PI_SCOLD_REMINDER_FUZZY_THRESHOLD` mapping to `relevance.fuzzyThreshold`. This field does not exist in v4 — fuzzy matching was dropped in favor of cosine similarity.

**Fix**: Remove `PI_SCOLD_REMINDER_FUZZY_THRESHOLD` from the ENV table. Replace it with:
```
PI_SCOLD_REMINDER_COSINE_THRESHOLD  →  relevance.cosineThreshold
```

This is blocking because a stale ENV mapping will cause `applyEnvironmentOverrides()` to silently write to a nonexistent field, or (worse) a developer will implement the override targeting `fuzzyThreshold` which is dead code.

---

## 3. Missing ENV Overrides for New Fields — BLOCKING ❌

**Issue**: Four `relevance.*` fields introduced in v4 have no ENV override in the plan's ENV table:

| Config Field | Missing ENV Name |
|---|---|
| `relevance.embeddingModel` | `PI_SCOLD_REMINDER_EMBEDDING_MODEL` |
| `relevance.embeddingDims` | `PI_SCOLD_REMINDER_EMBEDDING_DIMS` |
| `relevance.cosineThreshold` | `PI_SCOLD_REMINDER_COSINE_THRESHOLD` |
| `relevance.contextWindow` | `PI_SCOLD_REMINDER_CONTEXT_WINDOW` |

**Why this matters**: The parity standard requires ALL config fields to be overridable via ENV. Looking at session-title-interval as reference, every nested field has an ENV var (e.g., `PI_SESSION_TITLE_SELECTION_MODE`, `PI_SESSION_TITLE_FORMAT`, `PI_SESSION_TITLE_AGENT_TURNS`).

**Fix**: Add these 4 ENV vars to the ENV table and ensure `applyEnvironmentOverrides()` handles them:

```typescript
// In applyEnvironmentOverrides():
const model = env.PI_SCOLD_REMINDER_EMBEDDING_MODEL?.trim();
if (model) next.relevance.embeddingModel = model;

const dims = parseNumberEnv("PI_SCOLD_REMINDER_EMBEDDING_DIMS", env);
if (dims != null) next.relevance.embeddingDims = dims;

const cosine = parseNumberEnv("PI_SCOLD_REMINDER_COSINE_THRESHOLD", env);
if (cosine != null) next.relevance.cosineThreshold = cosine;

const ctxWindow = parseNumberEnv("PI_SCOLD_REMINDER_CONTEXT_WINDOW", env);
if (ctxWindow != null) next.relevance.contextWindow = ctxWindow;
```

**Complete corrected ENV table** (all 12 variables):

| Variable | Type | Maps to |
|----------|------|---------|
| `PI_SCOLD_REMINDER_ENABLED` | boolean | `enabled` |
| `PI_SCOLD_REMINDER_INJECT_EVERY` | number | `injectEvery` |
| `PI_SCOLD_REMINDER_INJECT_RANDOM` | boolean | `injectRandom` |
| `PI_SCOLD_REMINDER_MAX_INJECTIONS` | number | `maxInjections` |
| `PI_SCOLD_REMINDER_COOLDOWN_MS` | number | `cooldownMs` |
| `PI_SCOLD_REMINDER_RELEVANCE_MODE` | string | `relevance.mode` |
| `PI_SCOLD_REMINDER_EMBEDDING_ENDPOINT` | string | `relevance.embeddingEndpoint` |
| `PI_SCOLD_REMINDER_EMBEDDING_MODEL` | string | `relevance.embeddingModel` |
| `PI_SCOLD_REMINDER_EMBEDDING_DIMS` | number | `relevance.embeddingDims` |
| `PI_SCOLD_REMINDER_EMBEDDING_TIMEOUT` | number | `relevance.embeddingTimeoutMs` |
| `PI_SCOLD_REMINDER_COSINE_THRESHOLD` | number | `relevance.cosineThreshold` |
| `PI_SCOLD_REMINDER_DELIVERY_MODE` | string | `delivery.mode` |
| `PI_SCOLD_REMINDER_SUBAGENT_POLICY` | string | `subagentPolicy` |

---

## 4. Pool Items Deep Merge — PASS ✅

**Array replace semantics are correct.** The plan explicitly states:

> `pool` and `pairs` use **REPLACE** semantics (project replaces global entirely).

Both reference implementations (todo-enforcer, session-title-interval) use the same pattern: if either `base` or `override` is an array, `override` wins entirely. This means:

- Global config with 10 pool items → project config with 3 pool items → result has 3 items (project wins)
- Object items with `{ text, when, keywords, boost, weight }` are not individually merged — the entire array is replaced
- This is the correct behavior for content arrays (rules, pool, prompts) where positional order matters

No fix needed.

---

## 5. Config Validation Gaps — WARNING ⚠️

**Issue**: The plan's Step 2 mentions validation for existing fields (`injectEvery >= 1`, `maxInjections >= 0`, etc.) but omits validation for the 5 new v4 embedding fields. Per parity checklist item: *"Add test for ENV override"* — but there are also no explicit validation rules for the new fields.

**Missing validations that should be added to Step 2**:

| Field | Validation | Severity |
|---|---|---|
| `relevance.embeddingDims` | `Number.isInteger(v) && v > 0` — bad dims = vector math errors | HIGH |
| `relevance.cosineThreshold` | `v >= 0 && v <= 1` — out-of-range = never matches or always matches | HIGH |
| `relevance.embeddingTimeoutMs` | `v > 0` — zero/negative = instant timeout, always fallback | MEDIUM |
| `relevance.embeddingEndpoint` | Non-empty string, basic URL check (`startsWith("http")`) | LOW |
| Per-item `boost` | `v > 0` — zero/negative = item never selected | MEDIUM |
| Per-item `weight` | `v > 0` — zero/negative = item excluded from random | MEDIUM |

**Recommended validation function** (add to config.ts Step 2):

```typescript
function validateConfig(config: ScoldReminderConfig): string[] {
  const warnings: string[] = [];
  const r = config.relevance;
  
  if (!Number.isInteger(r.embeddingDims) || r.embeddingDims <= 0)
    warnings.push(`embeddingDims must be a positive integer, got ${r.embeddingDims}`);
  if (r.cosineThreshold < 0 || r.cosineThreshold > 1)
    warnings.push(`cosineThreshold must be 0..1, got ${r.cosineThreshold}`);
  if (r.embeddingTimeoutMs <= 0)
    warnings.push(`embeddingTimeoutMs must be > 0, got ${r.embeddingTimeoutMs}`);
  if (!r.embeddingEndpoint?.startsWith("http"))
    warnings.push(`embeddingEndpoint should be an HTTP URL, got "${r.embeddingEndpoint}"`);
  
  // Per-item validation
  for (const item of config.pool) {
    if (typeof item === "object") {
      if (item.boost !== undefined && item.boost <= 0)
        warnings.push(`pool item "${item.text.slice(0, 40)}..." has boost=${item.boost}, must be > 0`);
      if (item.weight !== undefined && item.weight <= 0)
        warnings.push(`pool item "${item.text.slice(0, 40)}..." has weight=${item.weight}, must be > 0`);
    }
  }
  
  return warnings;
}
```

This is a warning rather than blocking because the plan's validation section is a high-level spec — the exact validation rules can be filled in during implementation. But the plan should at minimum **list these validation requirements** so they aren't forgotten.

---

## 6. Missing example.json — BLOCKING ❌

**Issue**: The plan's file structure lists `scold-reminder.example.json` but:

1. **No example file content is provided** — the config schema section shows a "full config" JSON, but this is NOT the same as an annotated example file with field descriptions and ENV reference
2. **No ENV reference section** — per parity checklist: *"Create `<name>.example.json` with all fields documented + ENV reference"*
3. The plan references `scold-reminder.example.json` as a file that will be created, but never specifies its contents

**Fix**: Add a dedicated section to the plan with the full `scold-reminder.example.json` content. It should follow this structure (based on existing parity patterns):

```jsonc
{
  "// === Core Settings ===": "",
  "// Enable/disable the extension. ENV: PI_SCOLD_REMINDER_ENABLED": "",
  "enabled": true,
  
  "// Inject a reminder every N assistant turns. ENV: PI_SCOLD_REMINDER_INJECT_EVERY": "",
  "injectEvery": 5,
  
  "// ... (every field with comment annotation) ...": "",
  
  "// === Relevance / Embedding ===": "",
  "relevance": {
    "// Matching mode: 'embedding' (TEI cosine) or 'random'. ENV: PI_SCOLD_REMINDER_RELEVANCE_MODE": "",
    "mode": "embedding",
    
    "// TEI endpoint URL. ENV: PI_SCOLD_REMINDER_EMBEDDING_ENDPOINT": "",
    "embeddingEndpoint": "http://localhost:8004/v1/embeddings",
    
    "// Model ID for embeddings. ENV: PI_SCOLD_REMINDER_EMBEDDING_MODEL": "",
    "embeddingModel": "Qwen/Qwen3-Embedding-0.6B",
    
    "// Vector dimensions (must match model output). ENV: PI_SCOLD_REMINDER_EMBEDDING_DIMS": "",
    "embeddingDims": 1024,
    
    "// TEI request timeout in ms. ENV: PI_SCOLD_REMINDER_EMBEDDING_TIMEOUT": "",
    "embeddingTimeoutMs": 2000,
    
    "// Minimum cosine similarity to consider a match (0.0-1.0). ENV: PI_SCOLD_REMINDER_COSINE_THRESHOLD": "",
    "cosineThreshold": 0.3,
    
    "// Number of recent messages to evaluate. ENV: PI_SCOLD_REMINDER_CONTEXT_WINDOW": "",
    "contextWindow": 10
  },
  
  "// === Pool Items ===": "",
  "// Array of strings or objects. REPLACE semantics (project replaces global entirely).": "",
  "pool": [ "..." ],
  
  "// === ENV Override Reference ===": "",
  "// PI_SCOLD_REMINDER_ENABLED=1|true|0|false": "",
  "// PI_SCOLD_REMINDER_INJECT_EVERY=<number>": "",
  "// PI_SCOLD_REMINDER_INJECT_RANDOM=1|true|0|false": "",
  "// PI_SCOLD_REMINDER_MAX_INJECTIONS=<number>": "",
  "// PI_SCOLD_REMINDER_COOLDOWN_MS=<number>": "",
  "// PI_SCOLD_REMINDER_RELEVANCE_MODE=embedding|random": "",
  "// PI_SCOLD_REMINDER_EMBEDDING_ENDPOINT=<url>": "",
  "// PI_SCOLD_REMINDER_EMBEDDING_MODEL=<string>": "",
  "// PI_SCOLD_REMINDER_EMBEDDING_DIMS=<positive-int>": "",
  "// PI_SCOLD_REMINDER_EMBEDDING_TIMEOUT=<positive-ms>": "",
  "// PI_SCOLD_REMINDER_COSINE_THRESHOLD=<0.0-1.0>": "",
  "// PI_SCOLD_REMINDER_CONTEXT_WINDOW=<positive-int>": "",
  "// PI_SCOLD_REMINDER_DELIVERY_MODE=userMessage|customMessage": "",
  "// PI_SCOLD_REMINDER_SUBAGENT_POLICY=inherit|suppress|lighter": ""
}
```

---

## Parity Export Checklist

Verifying all required exports from config.ts are planned in Step 2:

| Export | Plan Mentions | Status |
|--------|--------------|--------|
| `DEFAULT_CONFIG` | ✅ Step 2 | PASS |
| `GLOBAL_CONFIG_PATH` | ✅ `~/.pi/scold-reminder.json` | PASS |
| `getProjectConfigPath(cwd)` | ✅ Step 2 | PASS |
| `readGlobalConfig()` | ✅ Step 2 | PASS |
| `writeGlobalConfig(config)` | ✅ Step 2 | PASS |
| `mergeConfigLayers(global, project)` | ✅ Step 2 | PASS |
| `loadConfig(cwd)` | ✅ Step 2 | PASS |
| `applyEnvironmentOverrides(config)` | ✅ Step 2 ("pure function, last step") | PASS |

All 8 required exports are accounted for. The plan also includes `loadConfigAsync` as an extra — this is fine.

---

## Config Path Convention

| Check | Expected | Actual | Status |
|-------|----------|--------|--------|
| Global config | `~/.pi/scold-reminder.json` | `~/.pi/scold-reminder.json` | ✅ |
| Project config | `<cwd>/.pi/scold-reminder.json` | `<cwd>/.pi/scold-reminder.json` | ✅ |
| ENV prefix | `PI_SCOLD_REMINDER_*` | `PI_SCOLD_REMINDER_*` | ✅ |

Consistent with session-title-interval (`~/.pi/session-title-interval.json`, `PI_SESSION_TITLE_*`).

---

## Summary of Required Fixes

| # | Severity | Issue | Fix |
|---|----------|-------|-----|
| 1 | **BLOCKING** | Stale `PI_SCOLD_REMINDER_FUZZY_THRESHOLD` in ENV table | Remove it, add `PI_SCOLD_REMINDER_COSINE_THRESHOLD` |
| 2 | **BLOCKING** | 4 new `relevance.*` fields missing ENV overrides | Add `EMBEDDING_MODEL`, `EMBEDDING_DIMS`, `COSINE_THRESHOLD`, `CONTEXT_WINDOW` |
| 3 | **BLOCKING** | No `scold-reminder.example.json` content in plan | Add dedicated section with annotated example + ENV reference |
| 4 | **WARNING** | No validation rules for embedding fields | Add validation spec for `embeddingDims`, `cosineThreshold`, `embeddingTimeoutMs`, `boost`, `weight` |

---

## Items That PASS (no changes needed)

- ✅ ENV prefix `PI_SCOLD_REMINDER_*` follows convention
- ✅ Array replace semantics for `pool` and `pairs` are correct
- ✅ All 8 required config.ts exports are planned
- ✅ Global/project config paths follow convention
- ✅ `applyEnvironmentOverrides()` called as last step in `mergeConfigLayers()`
- ✅ `parseBoolEnv()` / `parseNumberEnv()` pattern matches reference implementations
- ✅ Deep merge handles nested objects correctly (pool items as array = replace, relevance sub-object = merge)