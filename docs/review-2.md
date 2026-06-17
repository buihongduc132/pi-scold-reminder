# scold-reminder Plan Review — Config Parity Compliance

**Reviewer**: Automated config-parity audit  
**Date**: 2026-06-04  
**Reference patterns**: `todo-enforcer/config.ts`, `session-title-interval/config.ts`, `coding-guard-edit/config.ts`  
**Parity spec**: System prompt `Pi Extension Config Parity` section

---

## STRENGTHS

### S1. Well-designed core concept
The random/fuzzy pool injection + instruction-reminder pair architecture is sound. Mode `a` (random pool) and mode `b` (instruction → periodic reminders) are orthogonal and combinable. The intent is clear and well-motivated.

### S2. Hook lifecycle is correct
- `session_start` for config load + mode-b instruction injection — **correct placement**
- `message_end` (assistant) for turn counting — **correct hook, correct role filter**
- `agent_end` as safety net — matches todo-enforcer pattern
- All declared non-blocking — **complies with AGENTS.md "blocking is opt-in" rule**

### S3. Safety caps are well-thought-out
- `maxInjections: 20` prevents runaway injection
- `cooldownMs: 120000` prevents rapid-fire
- Turn-based + cooldown = double gate
- These are good defaults that prevent the extension from becoming a DoS vector

### S4. Delivery mode abstraction
Offering `userMessage` (default) and `customMessage` with `customType` mirrors the todo-enforcer `MessageDeliveryConfig` pattern exactly. This is correct.

### S5. Good file structure
Separation into `config.ts`, `selector.ts`, `turn-tracker.ts`, `context-extractor.ts` is clean. Each file has a single responsibility. Tests map 1:1 to modules.

---

## WEAKNESSES / CONCERNS

### W1. **CRITICAL — YAML config violates the parity standard**
The plan specifies:
```
Global:  ~/.scold-reminder.yml
Project: <cwd>/.scold-reminder.yml
```

**Every reference implementation uses JSON**, and the parity system prompt specifies JSON exclusively:

| Extension | Global Path | Project Path |
|-----------|-------------|--------------|
| session-title-interval | `~/.pi/session-title-interval.json` | `<cwd>/.pi/session-title-interval.json` |
| todo-enforcer | `~/.todo-enforcer.json` | `<cwd>/.todo-enforcer.json` |
| coding-guard-edit | `~/.config/coding-guard/config.json` | `<cwd>/.coding-guard.json` |
| pi-gitnexus-local | `~/.pi/pi-gitnexus-local.json` | `<cwd>/.pi/pi-gitnexus-local.json` |

**The plan also puts config in the wrong directories.** The parity standard specifies:
- Global: `~/.pi/<name>.json`  
- Project: `<cwd>/.pi/<name>.json`

The plan puts files at `~/.scold-reminder.yml` (home root) and `<cwd>/.scold-reminder.yml` (project root). This is a **double violation**: wrong format AND wrong paths.

The `js-yaml` dependency is also unnecessary — no other extension depends on a YAML parser.

### W2. **CRITICAL — Wrong ENV prefix**
The plan uses `SCOLD_REMINDER_*`. The parity convention is `PI_<EXTENSION_NAME>_*`:

```
Correct:   PI_SCOLD_REMINDER_ENABLED
Correct:   PI_SCOLD_REMINDER_INJECT_EVERY
Correct:   PI_SCOLD_REMINDER_MAX_INJECTIONS
Plan uses: SCOLD_REMINDER_ENABLED  ← missing PI_ prefix
```

Compare: `PI_SESSION_TITLE_ENABLED`, `PI_CODING_GUARD_CONFIG`, `PI_GITNEXUS_*`.

### W3. **CRITICAL — Missing required config exports**
The parity system prompt mandates these exports from every `config.ts`. The plan mentions some but not all:

| Required Export | In Plan? | Notes |
|----------------|----------|-------|
| `DEFAULT_CONFIG` | ✅ mentioned | OK |
| `GLOBAL_CONFIG_PATH` | ❌ missing | Must be `resolve(homedir(), ".pi", "scold-reminder.json")` |
| `getProjectConfigPath(cwd)` | ❌ missing | Must be `resolve(cwd, ".pi", "scold-reminder.json")` |
| `readGlobalConfig()` | ❌ missing | Must return `Partial<Config> \| null` |
| `writeGlobalConfig(config)` | ❌ missing | Must write to `~/.pi/scold-reminder.json` |
| `mergeConfigLayers(global, project)` | ⚠️ partial | Mentioned but no signature, no ENV layer |
| `loadConfig(cwd)` | ⚠️ partial | Listed as `loadConfigAsync` only — needs sync version too |
| `applyEnvironmentOverrides(config)` | ❌ missing | **Entirely absent from the plan** |

The plan does not mention `applyEnvironmentOverrides()` at all. This is the highest-priority layer (ENV wins over everything) and the plan omits it entirely.

### W4. **HIGH — Async-only config loading**
The plan specifies `loadConfigAsync(cwd: string): Promise<ScoldReminderConfig>` but no sync `loadConfig()`. The reference implementations (todo-enforcer, session-title-interval) provide **both** sync and async paths. The sync path is critical because pi extension hooks may be called in synchronous contexts.

### W5. **HIGH — Array merge semantics undefined**
The `pool` field is a `string[]`. During deep merge, arrays are typically **replaced** (not appended). The plan doesn't address this:
- If global has 5 pool items and project has 3, result = 3 (replace)? Or 8 (append)?
- If project wants to ADD to the global pool, how?
- The reference implementations all use "replace" semantics for arrays — the plan should be explicit about this.

Same issue with `pairs[]` — a project config with `pairs` should **replace** the global pairs, not append.

### W6. **HIGH — No `.example.json` file**
The parity checklist requires `<name>.example.json`. The plan specifies `scold-reminder.example.yml` — wrong format. Must be `scold-reminder.example.json` with all fields documented + ENV reference table.

### W7. **MEDIUM — Missing types.ts separation**
The parity template shows `types.ts` as a separate file. The plan lumps types into `config.ts`. This is a minor concern but diverges from the reference pattern (`todo-enforcer` keeps types in `config.ts`, but `session-title-interval` has separate `types.ts`). Not critical but worth noting for consistency.

### W8. **MEDIUM — Relevance mode fallback chain incomplete**
The plan specifies `fuzzy → BM25 → embedding` but doesn't address:
- What happens when fuzzy score is below threshold for ALL candidates? Should fall back to random.
- What happens when embedding endpoint is down? The plan says "fallback to fuzzy" but this creates a chain: embedding → fuzzy → random that isn't documented.
- The existing TEI deployment at the Nomad cluster should be the default embedding endpoint (see AGENTS.md "External Service Endpoints"), not Ollama.

### W9. **MEDIUM — Config validation too thin**
The plan says "Validation: at least 1 pool item OR 1 pair defined" but doesn't validate:
- `injectEvery` must be >= 1
- `maxInjections` must be >= 0
- `cooldownMs` must be >= 0
- `fuzzyThreshold` must be 0-1
- `relevance.mode` must be one of the valid values
- Pool strings must be non-empty
- Pair instructions must be non-empty

### W10. **LOW — Package naming**
The plan specifies `vendor-omo-pi-scold-reminder`. The convention in AGENTS.md Extensions table shows no other extension follows this pattern — they're referenced by directory name only. Package naming is less critical for local extensions but should be consistent with the existing convention.

---

## RECOMMENDED CHANGES (Must-Fix Before Implementation)

### R1. Switch from YAML to JSON
Replace all YAML references with JSON:
- `~/.scold-reminder.yml` → `~/.pi/scold-reminder.json`
- `<cwd>/.scold-reminder.yml` → `<cwd>/.pi/scold-reminder.json`
- `scold-reminder.example.yml` → `scold-reminder.example.json`
- Remove `js-yaml` dependency
- Use `JSON.parse` / `readFileSync` like every other extension

### R2. Implement the full parity export surface
`config.ts` MUST export all 8 required symbols:

```typescript
export const DEFAULT_CONFIG: ScoldReminderConfig = { /* ... */ };
export const GLOBAL_CONFIG_PATH = resolve(homedir(), ".pi", "scold-reminder.json");
export function getProjectConfigPath(cwd: string): string { /* ... */ }
export function readGlobalConfig(): Partial<ScoldReminderConfig> | null { /* ... */ }
export function writeGlobalConfig(config: Partial<ScoldReminderConfig>): void { /* ... */ }
export function mergeConfigLayers(global?, project?): ScoldReminderConfig { /* ... */ }
export function loadConfig(cwd: string): ScoldReminderConfig { /* ... */ }
export function applyEnvironmentOverrides(config: ScoldReminderConfig): ScoldReminderConfig { /* ... */ }
```

### R3. Fix ENV prefix
All environment variables MUST use `PI_SCOLD_REMINDER_*` prefix:

```
PI_SCOLD_REMINDER_ENABLED        → boolean
PI_SCOLD_REMINDER_INJECT_EVERY   → number
PI_SCOLD_REMINDER_INJECT_RANDOM  → boolean
PI_SCOLD_REMINDER_MAX_INJECTIONS → number
PI_SCOLD_REMINDER_COOLDOWN_MS    → number
PI_SCOLD_REMINDER_RELEVANCE_MODE → string (random|fuzzy|bm25|embedding)
PI_SCOLD_REMINDER_FUZZY_THRESHOLD → number
PI_SCOLD_REMINDER_DELIVERY_MODE  → string (userMessage|customMessage)
PI_SCOLD_REMINDER_CONTEXT_WEIGHTED → boolean
```

### R4. Implement `applyEnvironmentOverrides()`
Follow the session-title-interval pattern exactly:
- `parseBoolEnv()` — returns `true` for "1"/"true", `false` for "0"/"false", `null` for anything else (fall through)
- `parseNumberEnv()` — returns parsed number with `Number.isFinite()` validation, `null` on failure
- Pure function: takes config, returns new config with ENV applied
- Called as the LAST step in `mergeConfigLayers()`

### R5. Add sync `loadConfig()` alongside async
Provide both sync and async paths like todo-enforcer. The sync path is essential for hook handlers.

### R6. Document array merge semantics
State explicitly: arrays (`pool`, `pairs`) use **replace** semantics. Project config replaces global config's arrays entirely. If the user wants to append, they must include the global items in their project config.

---

## OPTIONAL IMPROVEMENTS

### O1. Relevance fallback chain
Define explicit chain: `embedding → bm25 → fuzzy → random`. Each level falls through when:
- Endpoint unavailable (embedding)
- All scores below threshold (bm25, fuzzy)
- This ensures a reminder is ALWAYS delivered when injection is triggered

### O2. Use existing TEI endpoint for embeddings
Instead of configuring a custom `embeddingEndpoint`, default to the existing TEI deployment behind the Caddy proxy (see AGENTS.md "External Service Endpoints"). This avoids a new external dependency.

### O3. Config caching
Load config once at `session_start`, cache in module-level variable. Don't reload on every `message_end`. The plan doesn't specify this but it's implied — make it explicit.

### O4. Lazy context extraction
Only extract conversation context when injection is actually triggered (turn count hits threshold). Don't extract on every `message_end` — that's wasteful for 4 out of 5 turns.

### O5. Suggestion ranking (S1-S8)
From the 8 suggested features, I rank them:

| Priority | Feature | Value | Cost |
|----------|---------|-------|------|
| **Phase 2** | S1: Tone Variation | High — prevents reminder blindness | Low — add `tone` field to each string |
| **Phase 2** | S2: Violation Detection | High — targeted reminders >> random | Medium — pattern matching engine |
| **Phase 3** | S3: Session-Adaptive Frequency | Medium — useful self-tuning | Medium — compliance tracking state |
| **Phase 3** | S6: Per-Subagent Profiles | Medium — sub-agents DO skip more | Medium — agent type detection |
| **Skip** | S4: Instruction Deduplication | Low — hard to get right | High — needs semantic comparison |
| **Skip** | S5: Injection Timing Strategies | Low — turn-based is sufficient | Medium — 3 new trigger modes |
| **Skip** | S7: A/B Testing Framework | Low — premature optimization | High — logging + analysis framework |
| **Skip** | S8: External Reminder Sources | Low — over-engineering for v1 | Medium — HTTP client + refresh logic |

**S1 and S2 are worth implementing.** S3 and S6 are reasonable Phase 3 candidates. S4/S5/S7/S8 are noise that should be dropped from the plan entirely to avoid scope creep.

---

## VERDICT: APPROVE_WITH_CHANGES

The plan's **core architecture is sound** — modes a/a1/b are well-designed, hooks are correctly placed, safety caps are sensible, and delivery abstraction matches the reference pattern.

However, the **config layering has 3 critical parity violations** (YAML instead of JSON, wrong paths, missing ENV prefix) and **missing required exports** that must be fixed before implementation begins. These are not cosmetic — they represent a fundamental departure from the established convention that every other extension follows.

**Changes required before implementation:**
1. **R1-R6** — All must-fix items above
2. Drop S4/S5/S7/S8 from the plan to prevent scope creep
3. Add explicit config caching and lazy context extraction notes

**After these changes, the plan is ready for implementation.** The phased approach (Phase 1: random pool + pairs → Phase 2: relevance matching → Phase 3: adaptive features) is correct and should be preserved.