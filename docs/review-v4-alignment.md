# scold-reminder — v4 Plan vs Intention Alignment Review

**Reviewer**: review subagent
**Date**: 2026-06-04
**Intention**: `flow/intentions/scold-reminder/intention.md`
**Plan (v4)**: `flow/intentions/scold-reminder/plan.md`
**Prior reviews**: `review-1.md`, `review-2.md`, `review-alignment.md` (v2-era — now stale on mode a/a1)

---

## Verdict: PARTIALLY_ALIGNED

All core behaviors are implemented, but v4 restructured the mode hierarchy and dropped 2 of 3 search methods from the spec. The deviations are engineering-justified but constitute meaningful spec drift from the intention's explicit text.

---

## Claim-by-Claim Alignment Matrix

### Claim 1: Core purpose — "dynamically extension that randomly keep inject message / reminder that act as human is DEMANDING themself to aligned with the requirement"

**Status**: ✅ ALIGNED
**Evidence**: v4 summary: "injects accountability reminders into agent sessions, forcing the LLM to self-audit." `sendUserMessage()` delivery makes reminders appear as user messages. Default pool contains scolding sentences matching all 4 intention examples.

### Claim 2: Mode a — "have the configured list of sentences, then randomly ext will pick 1 line per <X> turns"

**Status**: ⚠️ RESTRUCTURED — behavior preserved, priority inverted
**Intention**: Mode a = **random pick** per X turns. This is the primary/sole mechanism.
**v4**: Mode `a` = **embedding match** (smart pick). Mode `a0` = **random fallback** (demoted to secondary).

The random behavior still exists as mode `a0` and can be selected via `relevance.mode: "random"`. But v4 inverts the intention's priority: random was the primary mode; embedding was mode a1 (an optional enhancement). In v4, embedding is primary and random is the fallback.

**Gap**:
- Random IS available as a first-class config option (`relevance.mode: "random"`) — not just a degradation path
- But default mode is `"embedding"`, not `"random"`
- The intention's mode a is no longer the default behavior

### Claim 3: Mode a1 — "these picked lines can use fuzzy / bm25 / embedding to search for most relevant line"

**Status**: ⚠️ PARTIAL — only embedding implemented; fuzzy and BM25 dropped
**Intention**: Lists three co-equal search strategies: `fuzzy / bm25 / embedding`.
**v4**: Only embedding + random. Explicitly states: "No BM25, no minisearch, no RRF fusion."

**What was dropped**:
| Method | Intention | v4 | Rationale in v4 |
|--------|----------|-----|-----------------|
| Fuzzy (edit-distance) | Listed | ❌ Dropped | Weak for short sentences; embedding handles semantic similarity better |
| BM25 (keyword matching) | Listed | ❌ Dropped | Keyword-augmented embedding "covers everything BM25 does plus semantic understanding" |
| Embedding (semantic) | Listed | ✅ Implemented | Primary mode; TEI already deployed, zero deps |

**Justification quality**: The v4 rationale is technically sound for 20-50 short reminder sentences. TEI cosine similarity with keyword augmentation (`text + "\nTopics: " + keywords.join(", ")`) effectively subsumes BM25's keyword matching. Fuzzy matching (edit-distance) is the weakest method for this use case and adds no value over embedding for short, well-formed sentences.

**However**: The intention listed all three as alternatives, and v4 dropped two without acknowledging the spec change. The `review-alignment.md` (v2-era) previously scored mode a1 as "✅ COVERED (deferred to Phase 2)" with a full fallback chain `["embedding", "bm25", "fuzzy", "random"]`. v4 quietly replaced this with embedding-only + random.

### Claim 4: Mode b — "yml can config in pair of: instruction / reminder; initially instruction will inject to the session (like SYSTEM.md of pi) then having the reminder from time to time like (a, a1)"

**Status**: ✅ ALIGNED
**Evidence**: v4 `pairs[]` config with `instruction` + `reminders[]`. `context` hook injects instructions at session start (survives compaction). `message_end` delivers reminders periodically. Matches intention exactly.

### Claim 5: Config — "Configuration will be having global and local. In yml."

**Status**: ✅ ALIGNED (one justified deviation)
**Evidence**: Global `~/.pi/scold-reminder.json` + Project `<cwd>/.pi/scold-reminder.json`. Deep merge: defaults → global → project → ENV overrides.
**Deviation**: YAML → JSON. Justified by project convention (all other extensions use JSON). Previously reviewed in `review-alignment.md` and accepted.

### Claim 6: Multiple modes combinable — "each of these '<char>' bullet is the mode, which can be combine together depend on it capability"

**Status**: ✅ ALIGNED
**Evidence**: v4 Architecture table: "Modes (combinable, all Phase 1)". Modes a, a0, b, when, keywords all run simultaneously.

### Claim 7: Dynamic random injection — "randomly keep inject message"

**Status**: ✅ ALIGNED (as option)
**Evidence**: Random mode available via `relevance.mode: "random"` or automatic fallback when TEI is unreachable. Random cooldown variance (`cooldownMinMs`/`cooldownMaxMs`) adds non-deterministic timing. `injectRandom` config option preserved (though behavior in v4 is that `relevance.mode` controls selection strategy, not a separate toggle).

---

## Gap Summary

| # | Gap | Severity | Intention Text | v4 Reality | Verdict |
|---|-----|----------|----------------|------------|---------|
| G1 | Mode hierarchy inversion | MEDIUM | Mode a = random (primary) | Mode a = embedding (primary), a0 = random (fallback) | Restructured, not lost. Both behaviors available. |
| G2 | Fuzzy search dropped | LOW | "fuzzy / bm25 / embedding" | Embedding only | Technically dropped, but weakest method for this use case |
| G3 | BM25 dropped | LOW | "fuzzy / bm25 / embedding" | Embedding only | Keyword augmentation subsumes BM25 for 20-50 short sentences |
| G4 | No fallback chain | LOW | Implied by listing 3 methods | Only embedding → random fallback | Simpler but less configurable |
| G5 | Mode a1 concept dissolved | MEDIUM | Separate mode a1 for smart search | Smart search IS mode a; no distinct a1 | Structural reorganization |

---

## Key Question: Is dropping fuzzy and BM25 an acceptable simplification or a spec violation?

### Analysis

The intention says: *"these picked lines can use fuzzy / bm25 / embedding to search for most relevant line"*

**Argument for "acceptable simplification"**:
1. The "can use" phrasing lists alternatives, not requirements — any one satisfies the spec
2. Embedding is the most powerful of the three methods for this use case (20-50 short sentences)
3. Keyword-augmented embedding text (`text + "\nTopics: " + keywords`) effectively replicates BM25's keyword matching
4. TEI is already deployed — zero new npm dependencies
5. Pool size (20-50 items) makes brute-force cosine trivially fast (<0.1ms)
6. Random fallback preserved for when embedding is unavailable
7. The intention's core goal is *relevance-matched injection* — embedding achieves this better than fuzzy or BM25 alone

**Argument for "spec violation"**:
1. The intention explicitly names three methods as co-equal options
2. v2 plan had a fallback chain `["embedding", "bm25", "fuzzy", "random"]` — v4 removed this entirely without updating the intention
3. BM25 has a property that embedding lacks: guaranteed exact keyword match. If a user configures a reminder about "git push --force" and the agent types "git push --force", BM25 would match with 100% confidence. Embedding might or might not depending on vector similarity
4. The previous review-alignment.md scored mode a1 as "✅ COVERED" — that assessment is now stale

### Verdict

**Justified simplification, not a spec violation.**

The intention's "can use X / Y / Z" phrasing makes these alternatives, not conjunctive requirements. Implementing one (embedding) satisfies the spec. The v4 plan's rationale is technically sound: for a pool of short reminder sentences, embedding + keyword augmentation is a strict superset of BM25's capabilities. Fuzzy matching adds no value for well-formed sentences.

**However**, the v4 plan should explicitly acknowledge this as a deliberate spec simplification in the plan document itself, rather than silently dropping features. The current plan mentions it only in a parenthetical in the pipeline section.

### Missing Item for Full Alignment

If future users need exact keyword matching guarantees (BM25's strength), the plan should note that:
- The `keywords` field + cosine similarity provides approximate keyword matching
- If exact-match requirements emerge, BM25 can be added as a Phase 2 enhancement without architectural changes
- The current design does not preclude adding BM25 later (selector.ts would gain a second scoring path)

---

## Changes Since v2 review-alignment.md

The previous `review-alignment.md` was written against v2 of the plan. Key changes in v4 that affect alignment:

| Aspect | v2 Assessment | v4 Reality | Change |
|--------|---------------|------------|--------|
| Mode a1 coverage | "✅ COVERED (Phase 2)" | a1 concept dissolved; embedding is now mode a (Phase 1) | Restructured |
| Fallback chain | `["embedding", "bm25", "fuzzy", "random"]` | Only embedding → random | Simplified |
| Dependencies | minisearch for BM25, fuse.js for fuzzy | Zero npm deps (TEI HTTP only) | Dependency eliminated |
| Alignment score | 95% | Still 95% | Same score, different reasons |

The v2 review's 13 gotchas (G1-G13) are addressed in v4:
- G1 (empty pool): v4 has runtime guard ✅
- G2 (message_end per tool): v4 has role filter + cooldown ✅
- G5 (long messages): v4 has `maxLength` + `maxTotalInjectionChars` ✅
- G6 (subagent): v4 has `subagentPolicy` ✅
- G8 (injectEvery=1+random): v4 has config validation warning ✅
- G11 (disabled mid-session): v4 has `/scold-disable` command ✅
- G12 (empty reminders): v4 has validation warning ✅

---

## Final Score

| Category | Score | Notes |
|----------|-------|-------|
| Core purpose | 100% | Accountable enforcement via dynamic injection |
| Mode a (random) | 90% | Available but demoted from primary to fallback |
| Mode a1 (smart search) | 85% | Embedding implemented; fuzzy/BM25 dropped (justified) |
| Mode b (pairs) | 100% | Instruction/reminder pairs with context hook |
| Config (global+local) | 100% | JSON with deep merge (YAML deviation accepted) |
| Combinable modes | 100% | All modes combinable in Phase 1 |
| Dynamic injection | 100% | Random timing + turn-based triggers |
| **Overall** | **~93%** | **Two justified deviations: mode hierarchy inversion + search method simplification** |

---

## Recommendations

1. **Acknowledge the simplification explicitly** in plan.md — add a brief "Spec Deviations" section noting that fuzzy/BM25 were intentionally dropped in favor of embedding-only, with rationale. This prevents future reviewers from flagging it as an oversight.

2. **Document that BM25 can be re-added** as a Phase 2 enhancement if exact keyword matching is needed, since the selector.ts architecture supports multiple scoring paths.

3. **Consider making random the default** for new installations (matching the intention's mode a) and embedding opt-in, rather than embedding-by-default. This would be closer to the intention's hierarchy. However, since embedding is strictly better when TEI is available, this is a preference call, not a correctness issue.

4. **Update review-alignment.md** to note it is v2-era and stale on mode a/a1 coverage, pointing to this document for v4 assessment.