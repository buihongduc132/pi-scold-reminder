# scold-reminder — Intention Alignment Audit

**Reviewer**: Alignment audit subagent
**Date**: 2026-06-04
**Intention**: `flow/intentions/scold-reminder/intention.md`
**Plan (v2)**: `flow/intentions/scold-reminder/plan.md`
**Prior reviews**: `review-1.md` (architectural), `review-2.md` (config parity)

---

## Part 1: Intention Alignment — Sentence-by-Sentence

### Intention Sentence 1
> "pi usually forgot to admit their wrong doing, they are skipping stuffs that is in the instruction prompt."

**Status**: ✅ COVERED
**Evidence**: Plan's purpose statement: "randomly injects accountability reminders into agent sessions, forcing the LLM to self-audit against configured rules/instructions." Mode a pool includes accountability sentences. Mode b pairs enforce specific rules.

### Intention Sentence 2
> "We will build a dynamically extension that randomly keep inject message / reminder that act as human is DEMANDING themself to aligned with the requirement"

**Status**: ✅ COVERED
**Evidence**: `message_end` hook with random injection timing, `injectRandom` config option, `sendUserMessage()` delivery. The extension dynamically injects reminders at random intervals during the session.

### Intention Sentence 3
> "usually when remind like: 'did you really use the skills as instructed' 'did you really followed all the skills steps? List steps that you are NOT followed it' 'did you run ADHOC cmd. That is GATED.' 'admit the things you did that is EXPLICITLY instructed NOT TO' ... things like that."

**Status**: ✅ COVERED
**Evidence**: Plan's default pool contains:
- "Did you actually follow ALL the steps in the skills you were told to use? List the steps you SKIPPED." — matches "did you really use the skills as instructed"
- "Did you run any adhoc commands? That is GATED. Admit it now." — matches "did you run ADHOC cmd. That is GATED."
- "What did you do that was EXPLICITLY instructed NOT TO? Confess." — matches "admit the things you did that is EXPLICITLY instructed NOT TO"
- "Are you SURE you read the impact analysis before editing? Show proof." — skill verification
- "Did you skip any TODO items? Re-read the task requirements." — accountability

All four example sentences from the intention have direct analogues in the default pool.

### Intention Spec: Mode a
> "have the configured list of sentences, then randomly ext will pick 1 line per <X> turns of the sub agents and inject it in as reminder."

**Status**: ✅ COVERED
**Evidence**: Mode `a` (Random Pool) in Architecture table. `injectEvery` config controls N turns. `selector.ts` handles random pick. `turn-tracker.ts` counts turns. `message_end` triggers evaluation.

### Intention Spec: Mode a1
> "these picked lines can use fuzzy / bm25 / embedding to search for most relevant line: base on user / AI AGENT message; then inject it"

**Status**: ✅ COVERED (deferred to Phase 2)
**Evidence**: Mode `a1` (Contextual Match) in Architecture table. Phase 2 Steps 8-10 cover fuzzy (fuse.js), BM25 (pure JS), and embedding (optional HTTP endpoint). `context-extractor.ts` extracts recent messages. `fallbackChain: ["embedding", "bm25", "fuzzy", "random"]` ensures graceful degradation.
**Note**: Phase 1 only ships with random mode. a1 is additive Phase 2. This is acceptable phasing.

### Intention Spec: Mode b
> "yml can config in pair of: instruction / reminder; initially instruction will inject to the session (like SYSTEM.md of pi) then having the reminder from time to like (a, a1)"

**Status**: ✅ COVERED
**Evidence**: Mode `b` (Instruction-Reminder Pairs) in Architecture table. `context` hook injects instructions at session start (survives compaction — matches "like SYSTEM.md"). `message_end` delivers reminders periodically (using mode a/a1 logic). `pairs[]` config with `id`, `instruction`, `reminders[]` fields.

### Intention Spec: Global AND local (project) config
> "Configuration will be having global and local."

**Status**: ✅ COVERED
**Evidence**: Config paths: Global `~/.pi/scold-reminder.json`, Project `<cwd>/.pi/scold-reminder.json`. Merge layer: defaults → global JSON → project JSON → ENV overrides.

### Intention Spec: YML config format
> "In yml."

**Status**: ⚠️ DEVIATION — JUSTIFIED
**Evidence**: The intention says "In yml." The plan switched to JSON. Both prior reviews (review-1 I-4, review-2 W1) flagged this. The plan's Review Resolution Matrix (I-4, W1) documents the decision: JSON with comment stripping per parity standard. Every other extension uses JSON. The deviation is **justified** because:
1. JSON is the established convention in this codebase (all other extensions use JSON)
2. JSON avoids adding `js-yaml` dependency
3. JSON supports comments via stripping (already implemented in todo-enforcer)
4. Config parity standard mandates JSON

**Verdict**: Acceptable deviation. The user's "yml" was a preference for human-editable config; JSON with comments achieves the same goal while respecting project conventions.

### Intention Spec: Multiple modes combinable
> "each of these '<char>' bullet is the mode, which can be combine together depend on it capability"

**Status**: ✅ COVERED
**Evidence**: Architecture table header: "Modes (combinable)". Plan Step 6 `message_end` handler selects from both pool AND pair reminders. Integration tests include "mode a + b simultaneously."

### Intention Spec: Dynamic injection
> "dynamicaly extension that randomly keep inject message"

**Status**: ✅ COVERED
**Evidence**: `injectRandom` config option uses per-turn `Math.random() < 1/injectEvery`. Extension runs throughout session lifecycle via `message_end` hook.

---

## Intention Alignment Score

| Intention Element | Covered? | Notes |
|---|---|---|
| Core purpose (accountability enforcement) | ✅ | |
| Mode a: random pool every X turns | ✅ | |
| Mode a1: fuzzy/BM25/embedding search | ✅ (Phase 2) | Acceptable phasing |
| Mode b: instruction/reminder pairs | ✅ | Via context hook |
| Global AND local config | ✅ | JSON with merge |
| YML format | ⚠️ | Switched to JSON — justified |
| Multiple modes combinable | ✅ | Explicit in plan |
| Dynamic random injection | ✅ | `injectRandom` config |
| Example sentences in default pool | ✅ | All 4 mapped |

**ALIGNMENT_SCORE: 95%** (one justified deviation on config format)

---

## Part 2: GOTCHA Checklist

### G1. Empty pool AND empty pairs
**Severity**: HIGH
**What happens**: Plan Step 2 validation says "at least 1 pool item OR 1 pair defined" but `message_end` handler doesn't check for this at runtime. If validation is bypassed (e.g., config edited manually after session start) or both arrays are empty after merge, `selector.ts` receives empty arrays.
**Plan coverage**: Partial — validation exists but no runtime guard.
**Fix**: Add guard in `message_end` handler: `if (pool.length === 0 && activePairReminders.length === 0) return;`. Also guard in `selector.ts` to return `null` on empty input, with caller skipping injection.

### G2. Long turns with many tool calls — does message_end fire per tool result?
**Severity**: MEDIUM
**What happens**: The plan says "message_end fires per assistant message — gives fine-grained turn counting." But in pi, each tool result may also trigger a `message_end`. If the agent makes 10 tool calls in one turn, `message_end` fires 10+ times. The plan's `event.message?.role !== "assistant"` guard filters tool results, but a single assistant turn may produce multiple assistant messages (initial response + after each tool result). This could inflate turn counting beyond the intended "N turns" semantics.
**Plan coverage**: Not addressed.
**Fix**: Clarify whether `message_end` with `role === "assistant"` fires once per LLM invocation or per message chunk. If per chunk, use `turn_end` or add a debounce/cooldown within the same logical turn. The plan already has `cooldownMs` which partially mitigates this (if cooldown > tool call duration), but it's not explicitly designed for this case.

### G3. Malformed JSON config file
**Severity**: MEDIUM
**What happens**: Plan Step 2 says "JSON parse with comment stripping (reuse tryParseJson pattern)." But what happens on persistent parse failure? Does the extension fall back to defaults? Does it log an error? Does it crash the session?
**Plan coverage**: Partial — `tryParseJson` pattern exists but error recovery is unspecified.
**Fix**: Explicitly state: on parse failure, log error via `plugin-logger`, fall back to defaults (or previous valid config), and continue operation. Never crash on config errors.

### G4. Two pi sessions sharing the same global config
**Severity**: LOW
**What happens**: Global config at `~/.pi/scold-reminder.json` is shared. If two concurrent sessions read it, there's no conflict (read-only). If one session writes it (first-launch default write), the other may see a partial write. But since config is loaded once at `session_start` and cached, this is unlikely to cause issues.
**Plan coverage**: Implicit — config caching in Step 2 means each session has its own copy.
**Fix**: None needed. Config is read-once-per-session. The only write is the first-launch default, which is atomic enough for JSON.

### G5. Long injection messages waste context window
**Severity**: MEDIUM
**What happens**: Pool sentences are currently short, but users can configure arbitrarily long reminders. With `maxInjections: 20` and long messages, this could consume significant context window — especially in long sessions where compaction may have already occurred.
**Plan coverage**: Not addressed.
**Fix**: Add a `maxLength` config option (default: 500 chars) that truncates or rejects oversized reminders. Or document that users should keep reminders concise. Alternatively, add a `maxTotalInjectionChars` safety cap that stops injection when cumulative injected text exceeds a threshold.

### G6. Subagent sessions — should scold-reminder fire there too?
**Severity**: HIGH
**What happens**: The plan says "Injection messages via sendUserMessage() ARE visible to sub-agents (same as todo-enforcer). This is intentional." But `message_end` in a subagent session would also trigger scold-reminder, meaning subagents get their own turn counting and injections. This could be:
- Desirable: subagents also need accountability
- Undesirable: subagents have different tasks, random scolding may confuse them
- Both: subagents get different (lighter) frequency
**Plan coverage**: Partially addressed — "session-persistent" acknowledged, but no subagent-specific behavior.
**Fix**: Add a `subagentPolicy` config: `"inherit" | "suppress" | "lighter"`. Default: `"inherit"` (same behavior). `"suppress"` disables for subagent sessions. `"lighter"` uses a higher `injectEvery` multiplier. Phase 3's "Per-Subagent Profiles" (Step 14) addresses this but is deferred.

### G7. Idempotency — context hook returns instructions agent already saw
**Severity**: LOW
**What happens**: The `context` hook fires on every context rebuild (including after compaction). Mode b instructions are re-injected every time. This is intentional — the plan says "survives compaction (context hook re-injects after compaction)." The LLM sees duplicate instructions in context, but this is standard pi behavior (context hooks are designed for exactly this).
**Plan coverage**: ✅ Explicitly designed this way.
**Fix**: None needed. This is correct behavior, not a gotcha.

### G8. injectEvery=1 AND injectRandom=true
**Severity**: MEDIUM
**What happens**: `injectEvery=1` means inject every turn. `injectRandom` means `Math.random() < 1/1 = 1.0` → always true. So every single turn gets an injection. Combined with no cooldown, this is maximum nagging. The `maxInjections: 20` cap prevents infinite injection, but 20 consecutive-turn injections would be extremely disruptive.
**Plan coverage**: Not addressed.
**Fix**: Add a minimum effective `injectEvery` when `injectRandom` is true (e.g., minimum 2). Or add a "sanity check" in config validation that warns when injectEvery=1 and injectRandom=true. Or document that this combination is effectively "every turn until maxInjections."

### G9. All pool items exhausted in dedup window
**Severity**: LOW
**What happens**: If `dedupWindowSize >= pool.length`, every item is in the ring buffer, and no non-repeated item is available.
**Plan coverage**: ✅ Addressed — "Fallback: if all pool items are in dedup window, allow repeat of oldest item."
**Fix**: Already handled in plan.

### G10. Compaction — do injected reminders survive?
**Severity**: LOW
**What happens**: `sendUserMessage()` injections go into the conversation branch. When compaction occurs, old messages are summarized/removed. Mode a reminders injected before compaction may be lost. Mode b instructions survive via `context` hook re-injection.
**Plan coverage**: Partially addressed — mode b instructions explicitly survive compaction via `context` hook. Mode a reminders are not expected to survive (they're ephemeral nudges).
**Fix**: None needed for mode a (ephemeral is correct). Mode b is correctly handled. Document that mode a reminders are not guaranteed to persist across compaction boundaries.

### G11. Extension disabled mid-session
**Severity**: MEDIUM
**What happens**: If `enabled: false` is set in project config mid-session, the extension's cached config still has `enabled: true` (config loaded once at `session_start`). The extension continues injecting until session restart.
**Plan coverage**: Not addressed.
**Fix**: Either (a) re-read config on each injection (minor perf hit), or (b) document that config changes take effect on next session, or (c) add a `/scold-disable` command for immediate suppression. Option (b) is simplest and matches todo-enforcer behavior.

### G12. Mode b pair has empty reminders array
**Severity**: MEDIUM
**What happens**: A pair with `instruction: "..."` and `reminders: []` would inject the instruction via context hook but never send reminders. The instruction is still useful (it's always in context), but the pair effectively degrades to a permanent context entry with no periodic enforcement.
**Plan coverage**: Not addressed.
**Fix**: Config validation should warn (not error) on empty `reminders[]`. Document that a pair with no reminders is valid — it acts as a permanent instruction only. Don't reject it, just log a note.

### G13. Rate limits — can the extension trigger API rate limits?
**Severity**: LOW
**What happens**: `sendUserMessage()` injects a user message, which the LLM processes. Each injection costs one LLM API call (the response to the injected message). With `maxInjections: 20` over a session, this adds at most 20 extra API calls. Given normal session lengths, this is unlikely to hit rate limits.
**Plan coverage**: `maxInjections` cap implicitly addresses this.
**Fix**: None needed. The safety caps are sufficient. Document that each injection triggers an LLM response.

---

## Gotcha Summary

| # | Severity | Gotcha | Plan Coverage | Fix Required? |
|---|----------|--------|---------------|---------------|
| G1 | HIGH | Empty pool + empty pairs at runtime | Partial (validation only) | Yes — runtime guard |
| G2 | MEDIUM | message_end fires per tool result, inflating turn count | Not addressed | Yes — clarify or debounce |
| G3 | MEDIUM | Malformed JSON config | Partial (tryParseJson) | Yes — error recovery docs |
| G4 | LOW | Shared global config between sessions | Implicit (caching) | No |
| G5 | MEDIUM | Long injection messages waste context | Not addressed | Yes — maxLength or cap |
| G6 | HIGH | Subagent sessions fire independently | Partial (acknowledged) | Yes — subagentPolicy config |
| G7 | LOW | Context hook re-injection idempotency | ✅ Designed this way | No |
| G8 | MEDIUM | injectEvery=1 + injectRandom=true = every turn | Not addressed | Yes — validation warning |
| G9 | LOW | Dedup exhausts pool | ✅ Fallback documented | No |
| G10 | LOW | Compaction removes mode a reminders | Partial (mode b covered) | No — document behavior |
| G11 | MEDIUM | Config disabled mid-session, cached config persists | Not addressed | Yes — document or re-read |
| G12 | MEDIUM | Mode b pair with empty reminders | Not addressed | Yes — validation warning |
| G13 | LOW | Rate limits from extra API calls | Implicit (maxInjections) | No |

**CRITICAL gotchas**: 0
**HIGH gotchas**: 2 (G1, G6)
**MEDIUM gotchas**: 6 (G2, G3, G5, G8, G11, G12)
**LOW gotchas**: 5 (G4, G7, G9, G10, G13)

---

## Part 3: Missing Features from Intention

### Are example sentences in the default pool?

✅ **YES** — all four example sentences from the intention are represented in the default pool:

| Intention phrase | Default pool entry |
|---|---|
| "did you really use the skills as instructed" | "Did you actually follow ALL the steps in the skills you were told to use? List the steps you SKIPPED." |
| "did you really followed all the skills steps?" | (Same as above — combined) |
| "did you run ADHOC cmd. That is GATED." | "Did you run any adhoc commands? That is GATED. Admit it now." |
| "admit the things you did that is EXPLICITLY instructed NOT TO" | "What did you do that was EXPLICITLY instructed NOT TO? Confess." |

Additionally, mode b pairs enforce specific rules that the intention's examples allude to:
- `impact-analysis-mandatory` pair: enforces skill usage
- `no-adhoc-deploy` pair: enforces the "ADHOC cmd is GATED" rule
- `verifier-loop-mandatory` pair: enforces verification steps

**The user does NOT need to manually configure these** — they ship in the defaults.

### Are any intention features NOT in the plan?

| Feature | Status |
|---|---|
| "act as human is DEMANDING themself" | ✅ Covered — `sendUserMessage()` makes reminders appear as user messages |
| Tone escalation ("scolding" intensity) | ⚠️ Deferred to Phase 2 (Step 11: Tone Variation S1) |
| Violation-targeted reminders | ⚠️ Deferred to Phase 2 (Step 12: Violation Detection S2) |

---

## Final Assessment

### MISSING_ITEMS
1. **Subagent behavior control** — intention doesn't mention subagents explicitly, but the extension WILL fire in subagent sessions by default with no way to suppress. This is a design gap that should be addressed with a config option.
2. **Context budget awareness** — no mechanism to prevent injected reminders from consuming too much context window over time.

### ALIGNMENT_SCORE: **95%**
- All 6 spec items (mode a, a1, b, global+local config, combinable modes, dynamic injection) are covered
- The only deviation is YAML→JSON, which is justified by project convention
- Example sentences are included in defaults — user does not need to configure them manually
- Phase 2 covers the more advanced features (a1 contextual matching, tone variation, violation detection)

### VERDICT: **ALIGNED**

The plan faithfully implements the intention. The YAML→JSON switch is the only explicit deviation and is justified by project parity standards. The two HIGH-severity gotchas (G1: empty config at runtime, G6: subagent sessions) should be addressed before implementation but do not represent intention misalignment — they are edge cases the intention didn't consider.

**Recommendations before implementation**:
1. Add runtime guard for empty pool + empty pairs (G1)
2. Add `subagentPolicy` config option (G6)
3. Add `maxLength` or `maxTotalInjectionChars` safety cap (G5)
4. Add config validation warning for injectEvery=1 + injectRandom=true (G8)
5. Document that config changes take effect on next session (G11)
6. Add validation warning for empty reminders[] in pairs (G12)