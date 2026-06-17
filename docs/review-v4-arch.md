# scold-reminder v4 Plan — Architectural Review

**Reviewer**: review subagent  
**Date**: 2026-06-04  
**Plan**: `flow/intentions/scold-reminder/plan.md` (v4 — Embedding Always-On)  
**Reference impl**: `profile/extensions/todo-enforcer/`  
**Prior reviews**: `review-1.md`, `review-2.md`, `review-alignment.md`

---

## Verdict: **APPROVE_WITH_CHANGES**

The v4 plan is substantially sound. The embedding-first approach with TEI is a good architectural call — zero npm deps, GPU-backed, and the pipeline design is clean. All prior review issues (YAML→JSON, hook safety, config parity) are resolved. The remaining issues are specific race conditions and design gaps that should be addressed before implementation but don't require fundamental rearchitecting.

---

## Review Criteria

### 1. HOOK SAFETY — ✅ Correct, one race condition

**Correct**: All 4 hooks are declared `blocking: false` with `registerHook()` — matches the established pattern in todo-enforcer (`profile/extensions/todo-enforcer/index.ts:338-340`):

```typescript
registerHook("todo-enforcer", "session_start", { blocking: false, source: "pi", origin: "global" });
registerHook("todo-enforcer", "session_shutdown", { blocking: false, source: "pi", origin: "global" });
registerHook("todo-enforcer", "agent_end", { blocking: false, source: "pi", origin: "global" });
```

The plan's session_start handler wraps everything in try/catch — matches todo-enforcer's pattern (lines 344-360) where ctx fields are extracted immediately and all errors are caught.

**Correct**: The plan explicitly states "Warm embedding cache (fire-and-forget, non-blocking)" — this is the right approach per AGENTS.md: "fireAndForget THEN whenever the result came back it should be in the context."

**Issue R1 — Config load / cache warm race (MEDIUM)**:  
The plan's session_start handler lists two fire-and-forget operations:
1. "Load config (fire-and-forget)"
2. "Warm embedding cache (fire-and-forget)"

But cache warm depends on config being loaded (needs `embeddingEndpoint`, `embeddingModel`, and the normalized pool items list). If both are fire-and-forget, cache warm may fire before config loads complete — it would either crash or embed with stale/empty items.

**Fix**: Chain the cache warm AFTER config load resolves:
```typescript
void startConfigLoad(cwd).then(cfg => {
  if (cfg.relevance.mode === "embedding") {
    void warmCache(normalizePool(cfg));
  }
});
```
Or equivalently, make `warmCache` called from inside the config load `.then()`. Both are still non-blocking to the main thread.

---

### 2. STALE-CTX — ✅ Sound

**Correct**: The plan states "sessionId cached at session_start, never access stale ctx." This directly mirrors todo-enforcer's pattern:

```typescript
// todo-enforcer/index.ts:350-354
const sm = ctx.sessionManager;
setSessionState(sm.getSessionFile(), sm.getBranch());
const sessionId = getCachedSessionId();
```

The plan's `context-builder.ts` accesses the branch lazily (only when injection triggers), but uses cached branch reference — same pattern as todo-enforcer's `getCachedBranch()`.

**Correct**: `embedder.ts` is designed as a pure TEI HTTP client — no ctx access at all. It takes plain strings in, returns vectors out. No stale-ctx risk.

---

### 3. EMBEDDER LIFECYCLE — ⚠️ Gap: empty cache at first trigger

**Correct**: Cache warm at session_start is fire-and-forget. TEI unreachable → `teiAvailable = false` → random mode for the entire session. This is documented in gotcha GE1.

**Issue R2 — Cache not ready at first injection trigger (MEDIUM)**:  
The plan doesn't address the case where the first `message_end` injection trigger fires before cache warm completes. With `injectEvery: 5`, the first 5 assistant messages happen quickly (especially in a coding session where the agent fires multiple tool calls). The cache warm involves an HTTP round-trip to TEI (~63ms for batch of 5, so ~126ms for 70 items in 2 batches). Meanwhile, 5 assistant messages could arrive within the first 2-3 seconds.

The selector needs an explicit state check: `cache.ready === true` before attempting embedding selection. When `cache.ready === false` AND `teiAvailable !== false`, the selector should fall back to random for that specific injection (not set `teiAvailable = false` for the whole session).

**Fix**: Add a `cacheReady: boolean` field to `EmbeddingCache`. Selector logic:
```typescript
if (mode === "embedding" && cache.teiAvailable && cache.cacheReady) {
  // use embedding selection
} else {
  // random fallback (temporary if cache still warming)
}
```

**Correct**: The plan handles cache invalidation on config reload via `lastConfigHash` — good.

---

### 4. CONFIG PARITY — ⚠️ One stale ENV mapping

**Correct**: The plan lists 9 exports matching the parity standard: `DEFAULT_CONFIG`, `GLOBAL_CONFIG_PATH`, `getProjectConfigPath`, `readGlobalConfig`, `writeGlobalConfig`, `mergeConfigLayers`, `loadConfig`, `loadConfigAsync`, `applyEnvironmentOverrides`. This exceeds the todo-enforcer reference which exports `DEFAULT_CONFIG`, `tryParseJson`, `loadConfigAsync`, `loadConfig`, `interpolateTemplate`, `mergeConfigLayers`.

**Correct**: Config paths use `~/.pi/scold-reminder.json` (global) and `<cwd>/.pi/scold-reminder.json` (project) — matches parity standard. JSON format with comment stripping — matches todo-enforcer's `tryParseJson()`.

**Correct**: Array merge semantics (REPLACE for pool/pairs) are explicitly documented — this is the right call since merging reminder arrays would create confusing duplicates.

**Issue R3 — Stale ENV variable name (LOW)**:  
The ENV variable table (plan line 434) lists:
```
PI_SCOLD_REMINDER_FUZZY_THRESHOLD  →  relevance.fuzzyThreshold
```
But the actual config field is `relevance.cosineThreshold` (plan's own Config Fields table). This is a leftover from a pre-embedding plan version. The ENV variable should be `PI_SCOLD_REMINDER_COSINE_THRESHOLD` mapping to `relevance.cosineThreshold`.

**Fix**: Update the ENV table entry.

**Issue R4 — Missing ENV vars for embedding config (LOW)**:  
The config has 6 embedding-related fields (`embeddingEndpoint`, `embeddingModel`, `embeddingDims`, `embeddingTimeoutMs`, `cosineThreshold`, `contextWindow`) but only 2 have ENV mappings (`EMBEDDING_ENDPOINT`, `EMBEDDING_TIMEOUT`). The remaining 4 (`embeddingModel`, `embeddingDims`, `cosineThreshold` once renamed, `contextWindow`) have no ENV override. This is minor but incomplete parity.

**Fix**: Add ENV vars for `PI_SCOLD_REMINDER_EMBEDDING_MODEL`, `PI_SCOLD_REMINDER_EMBEDDING_DIMS`, `PI_SCOLD_REMINDER_COSINE_THRESHOLD`, `PI_SCOLD_REMINDER_CONTEXT_WINDOW`. Or document that embedding-specific config is not ENV-overridable (acceptable if intentional).

---

### 5. PERFORMANCE — ✅ Adequate

**Batch embed math**: 70 items (50 pool + 20 pair reminders) in 2 batches (50 + 20):
- Batch 1 (50 items): TEI handles up to 256, so this is well within limits.
- At ~63ms for 5 items, linear extrapolation gives ~630ms for 50 items. GPU-backed, likely faster with batching.
- 2s timeout is generous. ✅

**Cosine search**: Brute-force cosine against 70 cached vectors = 70 × 1024 multiplications = trivially fast (<0.1ms as the plan states). ✅

**Memory**: 70 × 1024 × 8 bytes (float64) = ~573KB. Negligible. ✅

**Issue R5 — session_start timing concern (LOW)**:  
"What if session_start fires before config loads?" — This is the same as R1. The config load is async, so the first few `message_end` events might not have config available. The plan should specify that `message_end` checks `config !== null` before proceeding (matching todo-enforcer's pattern where config is awaited via `getConfigWhenNeeded()`).

---

### 6. DEDUP + EMBEDDING — ⚠️ Subtle interaction

**Correct**: The dedup ring buffer (`dedupWindowSize: 5`) prevents the same reminder from being selected twice within 5 injections. This is a sound mechanism for preventing repetition.

**Issue R6 — Embedding determinism creates predictable rotation (MEDIUM)**:  
With embedding mode, the same conversation context always produces the same cosine scores for the same items. The conversation context changes slowly (assistant messages accumulate), so between two consecutive injections, the cosine ranking barely changes. Combined with dedup, this creates a predictable rotation:

1. Injection 1: pick item A (highest cosine)
2. Injection 2: A is dedup-blocked → pick item B (2nd highest cosine, nearly same ranking)
3. Injection 3: A, B dedup-blocked → pick item C
4. ...

This is **not a bug** — it's the expected behavior. But it means embedding mode effectively becomes "deterministic rotation through relevance-ranked items" rather than "pick the most relevant item each time." The dedup window of 5 means the system cycles through the top ~5 items predictably.

**Impact**: Low. The system still injects varied reminders, and the boost multiplier adds some differentiation. But the plan should document this behavior explicitly so implementers understand that embedding mode won't always pick "the most relevant" item — it picks "the most relevant item not recently used."

**Note**: If true randomness in selection is desired within the top-K candidates, the selector could add a small noise factor to cosine scores (e.g., `score = cosine * boost + random(-0.05, 0.05)`). This is optional — not required for v1.

**Issue R7 — Dedup + condition filtering creates eligible-item exhaustion (LOW)**:  
If condition filtering reduces eligible items to 3, and dedup window is 5, all 3 get dedup-blocked after 3 injections. Gotcha GC6 says "Fallback to all items" — but does "all items" bypass dedup? If it does, the user sees repeated reminders. If it doesn't, there are zero items to select and no injection fires (silently skipped).

**Fix**: GC6 should specify: when zero eligible items remain after dedup, reset the dedup ring buffer for this selection (not the whole session state) and re-select from eligible items.

---

### 7. COSINE THRESHOLD — ⚠️ Effectively always matches

**Observation**: The plan uses `cosineThreshold: 0.3`. For Qwen3-Embedding-0.6B with 1024 dimensions:

- Random unrelated text pairs typically score < 0.1
- Same-topic text pairs (accountability reminders about coding rules) will consistently score 0.3-0.7+
- The pool items are all "accountability/checking" themed — they're semantically close to each other

With 0.3 threshold, virtually any query about "coding work" will match multiple items. The threshold primarily filters out edge cases (empty query, completely off-topic conversation). **This means embedding mode almost never falls back to random** — random only triggers when TEI is down.

**Impact**: Not a problem per se, but the plan should document that with this threshold:
- `cosineThreshold` is effectively a safety rail, not a relevance filter
- The actual selection differentiator is the `boost` multiplier, not cosine similarity
- With multiple items having boost ≥ 2.0, the final ranking is `cosine(0.4-0.6) × boost(2.0-4.0) = 0.8-2.4`, where boost dominates

**Recommendation**: Consider raising threshold to 0.5 or documenting that 0.3 is intentionally permissive. This is a tuning concern, not a blocking issue.

---

### 8. GOTCHAS — New issues from embedding approach

**Issue R8 — TEI network timeout accumulates (MEDIUM)**:  
If TEI was reachable at session_start (cache warm succeeded) but becomes unreachable mid-session, each injection trigger attempts `queryEmbedding()` with a 2s timeout. If the agent produces messages every 10-20 seconds and `injectEvery: 5`, that's a 2s hang every 5th assistant message. Not blocking the main thread (async), but the `message_end` handler stalls for 2s before falling back to random.

**Fix**: If `queryEmbedding` fails once, set a session-level `teiQueryFailed: boolean` flag and skip embedding queries for the rest of the session (use cached vectors for selection, or fall back to random). This matches the existing `teiAvailable` pattern but for query-time failures.

**Issue R9 — TEI direct IP violates proxy rule (MEDIUM)**:  
The plan hardcodes `http://localhost:8004/v1/embeddings` as the TEI endpoint. AGENTS.md states:

> **ALWAYS point client config to the load-balanced proxy / gateway** — never to a single backend or canary instance. [...] Applies to: Hindsight (:24300 proxy, not :24301 backend or :24311 canary), TabbyAPI, **TEI**, or any Nomad-deployed service behind a Caddy/Nginx proxy.

The `localhost:8004` is a direct backend IP. If TEI has a Caddy/Nginx proxy fronting it (like Hindsight does at :24300), the config should point to the proxy instead.

**Fix**: Either:
1. Confirm that `:8004` IS the proxy (document this), or
2. Update the default endpoint to the TEI proxy URL

This is configurable via `relevance.embeddingEndpoint`, so the user can fix it at deploy time — but the default should be correct.

**Issue R10 — `context` hook injection may not persist across compaction (LOW)**:  
The plan says mode-b instructions are injected via the `context` hook and "survive compaction." The `context` hook in pi injects text that is re-injected on every context rebuild, so this is correct. But the plan should note that the `context` hook text counts toward the context window budget. With multiple pairs (the example has 3), each instruction is 50-150 chars — negligible for now, but worth documenting for future pairs expansion.

---

## Summary of Issues

| ID | Severity | Issue | Action |
|----|----------|-------|--------|
| R1 | MEDIUM | Config load / cache warm race condition | Chain warmCache after config load |
| R2 | MEDIUM | First injection before cache ready | Add `cacheReady` flag, random fallback when warming |
| R3 | LOW | Stale ENV var `FUZZY_THRESHOLD` → should be `COSINE_THRESHOLD` | Update ENV table |
| R4 | LOW | Missing ENV vars for 4 embedding config fields | Add or document intentional omission |
| R5 | LOW | message_end before config loads | Guard with `config !== null` check |
| R6 | MEDIUM | Embedding determinism + dedup = predictable rotation | Document behavior, optional noise factor |
| R7 | LOW | Dedup exhausts eligible items | GC6 should specify dedup ring buffer reset |
| R8 | MEDIUM | TEI timeout accumulates on repeated query failures | Add session-level query failure flag |
| R9 | MEDIUM | Direct IP violates proxy rule | Confirm :8004 is proxy, or update default |
| R10 | LOW | Context hook budget not documented | Add note about instruction text budget |

---

## Correct — What's Already Good

1. **Zero npm dependencies** — TEI via HTTP call is the right call. No minisearch, no fuse.js, no js-yaml.
2. **Hook safety** — All non-blocking, all try/catch wrapped, follows todo-enforcer patterns exactly.
3. **Stale-ctx prevention** — SessionId cached at session_start, embedder is pure HTTP client, context-builder is lazy.
4. **Config parity** — JSON format, correct paths, deep merge, ENV layer, first-launch defaults. All review-2 concerns resolved.
5. **Graceful degradation** — TEI down → random mode. Cache warm fails → random mode. Cosine below threshold → random mode. Multiple fallback layers, never blocks injection.
6. **Phase 1 is shippable** — Embedding + random + pairs + conditions + keywords all in Phase 1. No critical features deferred.
7. **Keyword augmentation** — `buildEmbeddingText` prepending "Topics: keywords" to embedding text is a clever trick that amplifies relevant signals in the vector space.
8. **Test coverage plan** — 7 test files with clear scope. `embedder.test.ts` covers timeout, fallback, keyword augmentation, graceful degradation.
9. **File structure** — Clean separation: types, config, embedder, selector, conditions, context-builder, turn-tracker. Each file has single responsibility.

---

## Recommended Implementation Order for Fixes

1. **R1 + R2** (race conditions) — Fix in `index.ts` session_start handler and `selector.ts`
2. **R8** (query failure flag) — Fix in `embedder.ts`
3. **R9** (proxy endpoint) — Fix in `config.ts` defaults
4. **R3 + R4** (ENV vars) — Fix in `config.ts` `applyEnvironmentOverrides()`
5. **R6 + R7** (dedup docs) — Document in code comments, no code change needed
6. **R10** (budget note) — Document in config comments