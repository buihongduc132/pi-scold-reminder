# scold-reminder — Granular Condition System (`when`)

_Designs the condition evaluation layer for scold-reminder, allowing per-item and per-pair eligibility gating._

---

## 1. Overview

Each pool item (string) and pair can carry a `when` field that controls **when** that reminder is eligible for injection. The condition system evaluates against a lazily-built `EvaluationContext` derived from the session branch.

**Inspiration sources:**
- **todo-enforcer `conditions.ts`**: Named conditions evaluated against a snapshot. We adopt the same registry pattern but with richer condition types.
- **cc-safety-net**: Regex-based command matching. We adopt `cmd_pattern` as a first-class condition type.

**Key difference from todo-enforcer**: todo-enforcer has a single `condition: string` field evaluated against a `TodoSnapshot`. Scold-reminder needs compound conditions (`and`/`or`) that inspect multiple aspects of session state (tools, messages, turn count), so we use a structured `when` object instead of a named string.

---

## 2. JSON Schema

### 2.1 Condition Union Type (`WhenCondition`)

```typescript
// ─── Primitive conditions ───────────────────────────────────────────────────

/** Match when specific tools were used in recent turns */
interface ToolUsedCondition {
  tool_used: string | string[];
}

/** Regex match on bash command content */
interface CmdPatternCondition {
  cmd_pattern: string; // regex pattern
}

/** String/regex match on recent assistant messages */
interface MessageContainsCondition {
  message_contains: string; // regex pattern
}

/** Only trigger after N turns */
interface TurnThresholdCondition {
  turn_threshold: number; // minimum turn count (>= 1)
}

/** Trigger when a specific tool has been used N+ times */
interface ToolCountCondition {
  tool_count: {
    tool: string;
    min: number; // minimum usage count
  };
}

/** Match when specific tools were NOT used recently (violation detection) */
interface NoToolUsedCondition {
  no_tool_used: string | string[];
}

/** Always eligible — default behavior */
interface AlwaysCondition {
  always: true;
}

/** Never eligible — disable a specific item without removing it */
interface NeverCondition {
  never: true;
}

// ─── Compound conditions ────────────────────────────────────────────────────

/** All sub-conditions must match (AND) */
interface AndCondition {
  and: WhenCondition[];
}

/** Any sub-condition must match (OR) */
interface OrCondition {
  or: WhenCondition[];
}

/** Negate a sub-condition (NOT) */
interface NotCondition {
  not: WhenCondition;
}

// ─── Union ──────────────────────────────────────────────────────────────────

type WhenCondition =
  | ToolUsedCondition
  | CmdPatternCondition
  | MessageContainsCondition
  | TurnThresholdCondition
  | ToolCountCondition
  | NoToolUsedCondition
  | AlwaysCondition
  | NeverCondition
  | AndCondition
  | OrCondition
  | NotCondition;
```

### 2.2 Pool Item Extension

Pool items can optionally carry a `when` field. Without it, `always: true` is assumed.

```typescript
// Before (flat strings):
pool: ["Did you run impact analysis?", ...]

// After (objects with optional when):
pool: [
  "Plain string — always eligible (backward compatible)",
  {
    text: "Did you use bash without checking the safety net?",
    when: { "tool_used": "bash" }
  },
  {
    text: "That edit was dangerous — did you check blast radius?",
    when: {
      "and": [
        { "tool_used": "edit" },
        { "no_tool_used": "gitnexus_impact" }
      ]
    }
  }
]

// TypeScript type for pool items:
type PoolItem = string | { text: string; when?: WhenCondition };
```

### 2.3 Pair Extension

Pairs gain an optional `when` field at the top level and per-reminder level.

```typescript
interface PairConfig {
  id: string;
  instruction: string;
  reminders: (string | { text: string; when?: WhenCondition })[];
  when?: WhenCondition; // eligibility gate for the entire pair
}
```

When a pair-level `when` fails, NO reminders from that pair are eligible. When a pair-level `when` passes, individual reminder-level `when` conditions further narrow the selection.

---

## 3. Evaluation Context

The condition evaluator needs session state. This is built lazily (only when at least one item has a non-trivial `when` condition) from the session branch.

```typescript
interface EvaluationContext {
  /** Current assistant turn count (1-indexed, 0 = first message not yet complete) */
  turnCount: number;

  /** Tools used in recent turns, in order of use (deduped, most recent first) */
  recentTools: string[];

  /** Total usage count per tool name across entire session */
  toolCounts: Map<string, number>;

  /** Bash command strings from recent tool calls (for cmd_pattern matching) */
  recentCommands: string[];

  /** Recent assistant message text content (for message_contains matching) */
  recentAssistantMessages: string[];
}
```

### 3.1 Context Builder (`buildEvaluationContext`)

```typescript
/**
 * Build evaluation context from session branch.
 * Called lazily — only when at least one item has a non-trivial when condition.
 *
 * @param branch - entries from ctx.sessionManager.getBranch()
 * @param messageWindow - how many recent messages to scan (default: 10)
 */
function buildEvaluationContext(
  branch: SessionEntry[],
  messageWindow: number = 10,
): EvaluationContext
```

**Implementation strategy:**
1. Iterate branch entries in **reverse** (most recent first)
2. Collect tool calls: `message.role === "assistant"` entries with `toolUse` content blocks → extract `toolName`
3. Collect bash commands: tool calls where `toolName === "bash"` → extract `input.command`
4. Collect assistant text: `message.role === "assistant"` entries → extract text content
5. Count tool usage: increment `toolCounts[toolName]` for every tool call
6. Stop after `messageWindow` entries (avoid scanning entire session history)

**Why reverse iteration?** The branch is ordered oldest-first. We want the N most recent entries, not the first N. Reverse iteration + counter is O(messageWindow) instead of O(branch.length).

**Exclusions (same as todo-enforcer):** Skip entries with `customType === "scold-reminder"` — don't let the extension's own injected messages trigger conditions.

---

## 4. Condition Evaluator (`conditions.ts`)

### 4.1 Core Evaluator

```typescript
/**
 * Evaluate a when condition against the current evaluation context.
 * Returns true if the condition matches (reminder is eligible for injection).
 */
export function evaluateWhen(
  condition: WhenCondition | undefined,
  ctx: EvaluationContext,
): boolean
```

**Logic:**

```typescript
export function evaluateWhen(
  condition: WhenCondition | undefined,
  ctx: EvaluationContext,
): boolean {
  // undefined → always eligible (backward compatible with plain strings)
  if (condition === undefined) return true;

  // Discriminated union dispatch
  if ("always" in condition) return condition.always === true;
  if ("never" in condition) return condition.never === true;

  if ("tool_used" in condition) return evalToolUsed(condition.tool_used, ctx);
  if ("cmd_pattern" in condition) return evalCmdPattern(condition.cmd_pattern, ctx);
  if ("message_contains" in condition) return evalMessageContains(condition.message_contains, ctx);
  if ("turn_threshold" in condition) return ctx.turnCount >= condition.turn_threshold;
  if ("tool_count" in condition) return evalToolCount(condition.tool_count, ctx);
  if ("no_tool_used" in condition) return evalNoToolUsed(condition.no_tool_used, ctx);

  // Compound
  if ("and" in condition) return condition.and.every(c => evaluateWhen(c, ctx));
  if ("or" in condition) return condition.or.some(c => evaluateWhen(c, ctx));
  if ("not" in condition) return !evaluateWhen(condition.not, ctx);

  // Unknown condition type — fail open (eligible)
  logger.warn("Unknown when condition type, treating as eligible", { condition });
  return true;
}
```

### 4.2 Individual Condition Evaluators

```typescript
function evalToolUsed(tools: string | string[], ctx: EvaluationContext): boolean {
  const toolList = Array.isArray(tools) ? tools : [tools];
  return toolList.some(t => ctx.recentTools.includes(t));
}

function evalCmdPattern(pattern: string, ctx: EvaluationContext): boolean {
  try {
    const re = new RegExp(pattern, "i");
    return ctx.recentCommands.some(cmd => re.test(cmd));
  } catch (err) {
    logger.error("Invalid cmd_pattern regex", { pattern, error: String(err) });
    return false; // invalid regex → condition fails safe (not eligible)
  }
}

function evalMessageContains(pattern: string, ctx: EvaluationContext): boolean {
  try {
    const re = new RegExp(pattern, "i");
    return ctx.recentAssistantMessages.some(msg => re.test(msg));
  } catch (err) {
    logger.error("Invalid message_contains regex", { pattern, error: String(err) });
    return false;
  }
}

function evalToolCount(spec: { tool: string; min: number }, ctx: EvaluationContext): boolean {
  const count = ctx.toolCounts.get(spec.tool) ?? 0;
  return count >= spec.min;
}

function evalNoToolUsed(tools: string | string[], ctx: EvaluationContext): boolean {
  const toolList = Array.isArray(tools) ? tools : [tools];
  return toolList.every(t => !ctx.recentTools.includes(t));
}
```

### 4.3 Custom Condition Registry (extensibility)

Following the todo-enforcer pattern, allow external registration:

```typescript
export type WhenConditionFn = (ctx: EvaluationContext) => boolean;

const customConditions: Map<string, WhenConditionFn> = new Map();

export function registerWhenCondition(name: string, fn: WhenConditionFn): void {
  customConditions.set(name, fn);
}
```

Custom conditions are referenced via a `custom` key:

```typescript
interface CustomCondition {
  custom: string; // registered condition name
}

// In evaluateWhen:
if ("custom" in condition) {
  const fn = customConditions.get(condition.custom);
  if (!fn) {
    logger.warn(`Unknown custom condition: "${condition.custom}"`);
    return false;
  }
  try {
    return fn(ctx);
  } catch (err) {
    logger.error(`Custom condition "${condition.custom}" threw`, err);
    return false;
  }
}
```

---

## 5. Integration with Selector (`selector.ts`)

### 5.1 Current Flow (from plan.md)

```
message_end → shouldInject() → selectRandom(pool) → deliver
```

### 5.2 New Flow with Conditions

```
message_end
  → shouldInject() // turn count + cooldown (unchanged)
  → buildEvaluationContext(branch, messageWindow) // NEW: lazy
  → filterEligibleItems(pool, pairs, evalCtx) // NEW: condition gate
  → selectFrom(eligible, dedupWindow) // existing selection logic
  → deliver
```

### 5.3 `filterEligibleItems`

```typescript
interface EligibleItem {
  text: string;
  source: "pool" | "pair";
  pairId?: string;
}

function filterEligibleItems(
  pool: PoolItem[],
  pairs: PairConfig[],
  evalCtx: EvaluationContext,
): EligibleItem[] {
  const eligible: EligibleItem[] = [];

  // Process pool items
  for (const item of pool) {
    const { text, when } = normalizePoolItem(item);
    if (evaluateWhen(when, evalCtx)) {
      eligible.push({ text, source: "pool" });
    }
  }

  // Process pairs
  for (const pair of pairs) {
    // Pair-level gate
    if (!evaluateWhen(pair.when, evalCtx)) continue;

    // Reminder-level gate
    for (const reminder of pair.reminders) {
      const { text, when } = normalizePoolItem(reminder);
      if (evaluateWhen(when, evalCtx)) {
        eligible.push({ text, source: "pair", pairId: pair.id });
      }
    }
  }

  return eligible;
}
```

### 5.4 Performance Guard

Building `EvaluationContext` is the expensive operation (branch scan). Add a shortcut:

```typescript
function hasAnyConditions(pool: PoolItem[], pairs: PairConfig[]): boolean {
  for (const item of pool) {
    if (typeof item !== "string" && item.when !== undefined) return true;
  }
  for (const pair of pairs) {
    if (pair.when !== undefined) return true;
    for (const r of pair.reminders) {
      if (typeof r !== "string" && r.when !== undefined) return true;
    }
  }
  return false;
}
```

When no item has conditions, skip context building entirely and treat all items as eligible (zero overhead for simple configs).

---

## 6. Example Config (All Condition Types)

```jsonc
{
  "enabled": true,
  "injectEvery": 5,
  "maxInjections": 20,
  "cooldownMs": 120000,
  "dedupWindowSize": 5,
  "delivery": { "mode": "userMessage" },

  "pool": [
    // Plain string — always eligible (backward compatible)
    "Did you actually follow ALL the steps in the skills you were told to use? List the steps you SKIPPED.",

    // tool_used: only after bash
    {
      "text": "You just ran a bash command. Did you check the safety rules first?",
      "when": { "tool_used": "bash" }
    },

    // tool_used (array): after any edit operation
    {
      "text": "Did you run impact analysis before editing? This is MANDATORY.",
      "when": { "tool_used": ["edit", "write"] }
    },

    // cmd_pattern: detect dangerous commands
    {
      "text": "DANGER: You ran a destructive command. Was this REALLY necessary? Did you use the deploy pipeline?",
      "when": { "cmd_pattern": "rm\\s+-rf|force.*push|sudo|chmod\\s+777" }
    },

    // message_contains: detect corner-cutting language
    {
      "text": "I detected corner-cutting language. Are you SURE you followed all requirements? Re-read them.",
      "when": { "message_contains": "skip|bypass|quick|just use|shortcut|simple enough" }
    },

    // turn_threshold: don't nag early in the session
    {
      "text": "Mid-session check: are you still following instructions? List any rules you've relaxed.",
      "when": { "turn_threshold": 10 }
    },

    // tool_count: after many bash calls, remind about safety
    {
      "text": "You've been running a lot of bash commands. Are you falling into manual mode instead of using skills?",
      "when": { "tool_count": { "tool": "bash", "min": 8 } }
    },

    // no_tool_used: violation detection — edit without impact analysis
    {
      "text": "⚠️ You edited code without running gitnexus_impact. Blast radius check is NOT optional.",
      "when": {
        "and": [
          { "tool_used": "edit" },
          { "no_tool_used": "gitnexus_impact" }
        ]
      }
    },

    // compound OR: bash or sudo detected
    {
      "text": "Shell command detected. Did you verify this is not an adhoc bypass of a gated operation?",
      "when": {
        "or": [
          { "tool_used": "bash" },
          { "cmd_pattern": "sudo" }
        ]
      }
    },

    // NOT: remind only when gitnexus was NOT used recently
    {
      "text": "Have you checked symbol dependencies recently? gitnexus_impact should be used before edits.",
      "when": {
        "not": { "tool_used": "gitnexus_impact" }
      }
    },

    // complex compound: edit tool used 5+ times, no gitnexus at all
    {
      "text": "CRITICAL: You've edited code 5+ times without ANY impact analysis. This violates project rules.",
      "when": {
        "and": [
          { "tool_count": { "tool": "edit", "min": 5 } },
          { "no_tool_used": "gitnexus_impact" }
        ]
      }
    }
  ],

  "pairs": [
    {
      "id": "impact-analysis-mandatory",
      "instruction": "CRITICAL RULE: You MUST run `gitnexus_impact` before editing ANY symbol. No exceptions.",
      "when": { "tool_used": "edit" },
      "reminders": [
        "Remember: impact analysis is MANDATORY before every edit. Did you run it?",
        {
          "text": "⚠️ Stop. You edited without checking blast radius. This is not optional.",
          "when": { "no_tool_used": "gitnexus_impact" }
        },
        "Impact analysis check: when was the last time you ran gitnexus_impact?"
      ]
    },
    {
      "id": "verifier-loop-mandatory",
      "instruction": "You MUST use the verifier-loop skill before claiming ANY work is complete.",
      "reminders": [
        {
          "text": "Verifier loop: did you run it? Or are you skipping quality gates again?",
          "when": { "turn_threshold": 5 }
        }
      ]
    },
    {
      "id": "no-adhoc-deploy",
      "instruction": "NEVER deploy directly from shell. Use the deployment pipeline.",
      "when": { "cmd_pattern": "rsync|scp|cp.*\\.pi/|deploy" },
      "reminders": [
        "Did you try to bypass the deploy pipeline? Adhoc deploys are flagged."
      ]
    }
  ]
}
```

---

## 7. File Layout

```
profile/extensions/scold-reminder/
├── index.ts                 ← entry point (updated: calls filterEligibleItems)
├── config.ts                ← config loader (updated: PoolItem type, when in pairs)
├── types.ts                 ← all TypeScript interfaces (updated: WhenCondition, EvaluationContext)
├── conditions.ts            ← NEW: condition evaluator (evaluateWhen, custom registry)
├── context-builder.ts       ← NEW: builds EvaluationContext from session branch
├── selector.ts              ← updated: filterEligibleItems + selectFrom
├── turn-tracker.ts          ← unchanged
├── context-extractor.ts     ← unchanged (still used for relevance matching in a1)
├── scold-reminder.example.json
├── package.json
├── tsconfig.typecheck.json
└── vitest.config.ts

Tests:
├── conditions.test.ts       ← NEW: condition evaluator unit tests
├── context-builder.test.ts  ← NEW: context builder unit tests
├── selector.test.ts         ← updated: filterEligibleItems + condition integration
├── config.test.ts
├── turn-tracker.test.ts
└── index.test.ts
```

---

## 8. Implementation Plan

### Step 1: Add types to `types.ts`

Add `WhenCondition`, `EvaluationContext`, `PoolItem`, and update `PairConfig` with optional `when` fields. Add the `normalizePoolItem` helper:

```typescript
export function normalizePoolItem(item: PoolItem): { text: string; when?: WhenCondition } {
  return typeof item === "string" ? { text: item } : { text: item.text, when: item.when };
}
```

### Step 2: Create `context-builder.ts`

Implement `buildEvaluationContext(branch, messageWindow)`:
- Reverse-iterate branch entries
- Extract tool names, bash commands, assistant text
- Build `toolCounts` map
- Return `EvaluationContext`
- Exclude scold-reminder's own injected messages (by customType)
- Default `messageWindow: 10` (configurable via config if needed)

### Step 3: Create `conditions.ts`

Implement `evaluateWhen(condition, ctx)`:
- Discriminated union dispatch
- All 8 primitive condition types + `not`
- Custom condition registry
- Error safety: invalid regex → condition fails (not eligible), unknown condition type → log + fail open
- Export `evaluateWhen`, `registerWhenCondition`, `hasAnyConditions`

### Step 4: Update `config.ts`

- Add `PoolItem` type to config interface
- Update `PairConfig` with `when` fields
- Backward-compatible: pool can be `string[]` or `PoolItem[]` (mixed)
- Validation: `when` fields are optional; if present, validate structure

### Step 5: Update `selector.ts`

- Add `filterEligibleItems(pool, pairs, evalCtx)`
- Add `hasAnyConditions()` shortcut
- Integrate into `selectRandom()` / `selectWeighted()`:
  - If no conditions exist → skip filtering (all eligible)
  - If conditions exist → build context → filter → select from eligible subset
- Fallback: if filtering produces zero eligible items, treat all items as eligible (never block all injections due to conditions)

### Step 6: Update `index.ts`

- In `message_end` handler, after `shouldInject()` returns true:
  - Call `hasAnyConditions()` to check if filtering is needed
  - If yes, get branch via `ctx.sessionManager.getBranch()` and build context
  - Pass context to selector
- **Stale-ctx safety**: branch access is immediate (no caching), performed right before selection

### Step 7: Tests

See Section 9 below.

---

## 9. Test Plan

### 9.1 `conditions.test.ts` — Condition Evaluator

| Test | Description |
|------|-------------|
| undefined condition → true | Backward compatibility: no `when` = always eligible |
| `always: true` → true | Explicit always |
| `never: true` → false | Explicit never |
| `tool_used` single match | Single tool in recentTools → true |
| `tool_used` single no match | Tool not in recentTools → false |
| `tool_used` array match | Any tool matches → true |
| `tool_used` array no match | None match → false |
| `cmd_pattern` match | Command matches regex → true |
| `cmd_pattern` no match | Command doesn't match → false |
| `cmd_pattern` invalid regex | Invalid regex → false + error log |
| `message_contains` match | Message text matches → true |
| `message_contains` no match | No match → false |
| `message_contains` invalid regex | Invalid regex → false + error log |
| `turn_threshold` met | turnCount >= threshold → true |
| `turn_threshold` not met | turnCount < threshold → false |
| `tool_count` met | count >= min → true |
| `tool_count` not met | count < min → false |
| `tool_count` tool never used | count = 0, min > 0 → false |
| `no_tool_used` absent | Tool NOT in recentTools → true |
| `no_tool_used` present | Tool IS in recentTools → false |
| `no_tool_used` array all absent | All tools absent → true |
| `no_tool_used` array some present | At least one present → false |
| `and` all true | All sub-conditions true → true |
| `and` one false | One sub-condition false → false |
| `and` empty array | Empty array → true (vacuously) |
| `or` any true | One sub-condition true → true |
| `or` all false | All sub-conditions false → false |
| `or` empty array | Empty array → false |
| `not` true → false | Negation inverts |
| `not` false → true | Negation inverts |
| nested compound | `{ and: [{ or: [...] }, { not: { ... } }] }` |
| unknown condition type | Unknown → true + warning log |
| custom condition | Registered custom condition evaluates |
| custom condition unknown | Unregistered name → false + warning log |
| custom condition throws | Exception → false + error log |

### 9.2 `context-builder.test.ts` — Context Builder

| Test | Description |
|------|-------------|
| empty branch | Returns empty context, turnCount 0 |
| single assistant message | Extracts text, counts 0 tools |
| tool calls extracted | Correct tool names in recentTools |
| tool counts accumulated | Multiple uses of same tool counted |
| bash commands extracted | command strings in recentCommands |
| reverse order | recentTools is most-recent-first |
| message window respected | Only last N entries scanned |
| self-injection excluded | scold-reminder customType entries skipped |
| mixed content | Tool calls + text + user messages handled correctly |
| toolResult messages | Ignored for tool_used (only toolUse blocks count) |

### 9.3 `selector.test.ts` — Filter + Selection Integration

| Test | Description |
|------|-------------|
| all plain strings | No filtering, all eligible |
| mixed pool | Some with conditions, some without |
| all filtered out | Zero eligible → fallback to all items |
| pair-level gate | Pair `when` blocks all its reminders |
| reminder-level gate | Pair passes but specific reminder blocked |
| dedup with conditions | Dedup only among eligible items |
| empty eligible pool | Edge case: no items match conditions |

---

## 10. GOTCHAS

### G-1: `tool_used` checks recent, not all-time

**Issue**: `tool_used` only scans the `messageWindow` most recent branch entries. A tool used 50 turns ago won't match.

**Mitigation**: This is intentional — `tool_used` is for "did you just do X?" not "did you ever do X?". For all-time counting, use `tool_count` instead.

**Config docs**: Document this distinction clearly.

### G-2: `no_tool_used` has the same recency limitation

**Issue**: `no_tool_used: "gitnexus_impact"` only checks the recent window. If impact analysis was run 20 turns ago (outside window), the condition would trigger — potentially a false positive.

**Mitigation**: Default `messageWindow: 10` is reasonable for most sessions. Could add a `tool_count: { tool: "gitnexus_impact", min: 1 }` as a positive check instead. Document the difference clearly.

### G-3: Regex compilation on every evaluation

**Issue**: `cmd_pattern` and `message_contains` compile regexes on every call.

**Mitigation**: Acceptable cost — regex compilation is fast (microseconds) and evaluation only happens when `shouldInject()` returns true (not every turn). If it becomes a bottleneck, add a regex cache keyed by pattern string.

### G-4: Compound condition infinite recursion

**Issue**: Deeply nested `and`/`or`/`not` could cause stack overflow.

**Mitigation**: Add a depth limit (default: 10 levels). If exceeded, log a warning and return `true` (fail open).

```typescript
function evaluateWhen(condition: WhenCondition | undefined, ctx: EvaluationContext, depth: number = 0): boolean {
  if (depth > 10) {
    logger.warn("Condition nesting depth exceeded, treating as eligible");
    return true;
  }
  // ... pass depth + 1 to recursive calls
}
```

### G-5: Backward compatibility with flat string pools

**Issue**: Existing configs have `pool: ["string1", "string2"]`. The new system must not break them.

**Mitigation**: `PoolItem = string | { text: string; when?: WhenCondition }`. The `normalizePoolItem` helper handles both forms. Plain strings have no `when` → `evaluateWhen(undefined, ctx) → true`. Zero behavioral change for existing configs.

### G-6: Zero eligible items after filtering

**Issue**: All items have conditions and none match → nothing to inject → wasted turn.

**Mitigation**: `filterEligibleItems` returns empty → selector falls back to treating ALL items as eligible. This ensures the extension always injects something on scheduled turns. Log a warning so the user knows their conditions are over-filtering.

### G-7: `cmd_pattern` only sees bash commands

**Issue**: `cmd_pattern` inspects `event.input.command` from bash tool calls. It does NOT see edit paths, read paths, or other tool inputs.

**Mitigation**: Document this clearly. For non-bash patterns, use `tool_used` or `message_contains` instead.

### G-8: Condition evaluation happens at selection time, not at injection time

**Issue**: There's a brief window between evaluation and injection where state could change (another tool call completes). This is acceptable — the condition was true at evaluation time.

**Mitigation**: No action needed. Same approach as todo-enforcer (evaluate at `agent_end`, inject immediately).

### G-9: `message_contains` can match the extension's own injected messages

**Issue**: A previously injected reminder might contain words that trigger `message_contains` conditions on the next turn.

**Mitigation**: The context builder already excludes entries with `customType === "scold-reminder"`. For `sendUserMessage` mode (where messages appear as user messages), the builder should also exclude user messages matching known reminder patterns (use a marker prefix like `[scold]`).

### G-10: `turn_threshold: 0` vs `turn_threshold: 1`

**Issue**: Turn 0 is the first assistant message (per plan.md, never inject on turn 0). A `turn_threshold: 0` would be eligible immediately.

**Mitigation**: Validate `turn_threshold >= 1` in config validation. The turn 0 guard in the turn tracker prevents injection before the first complete turn regardless.

### G-11: Config merge semantics for pool objects

**Issue**: Pool items are now objects with `when` fields. The REPLACE merge semantics from plan.md (project pool replaces global pool entirely) means project configs must include ALL items they want, including those without conditions.

**Mitigation**: This is consistent with the existing design (REPLACE semantics). Document that `pool` replacement is wholesale — use the full list in project config.

### G-12: Performance: branch scan on every injection

**Issue**: Building `EvaluationContext` requires scanning the session branch via `ctx.sessionManager.getBranch()`. For long sessions, the branch can be large.

**Mitigations**:
1. `hasAnyConditions()` shortcut — skip entirely if no conditions configured
2. `messageWindow` limit — only scan last N entries (default 10)
3. Only runs when `shouldInject()` returns true (not every turn)
4. Combined overhead is negligible compared to the LLM call the injection triggers

---

## 11. Summary of Types

```typescript
// types.ts additions

type WhenCondition =
  | { tool_used: string | string[] }
  | { cmd_pattern: string }
  | { message_contains: string }
  | { turn_threshold: number }
  | { tool_count: { tool: string; min: number } }
  | { no_tool_used: string | string[] }
  | { always: true }
  | { never: true }
  | { and: WhenCondition[] }
  | { or: WhenCondition[] }
  | { not: WhenCondition }
  | { custom: string };

type PoolItem = string | { text: string; when?: WhenCondition };

interface EvaluationContext {
  turnCount: number;
  recentTools: string[];
  toolCounts: Map<string, number>;
  recentCommands: string[];
  recentAssistantMessages: string[];
}

interface PairConfig {
  id: string;
  instruction: string;
  reminders: (string | { text: string; when?: WhenCondition })[];
  when?: WhenCondition;
}
```

---

## 12. Migration Path

1. **Phase 1 (with conditions)**: Add `conditions.ts` + `context-builder.ts`. Pool items accept both `string` and `{ text, when }` forms. No breaking changes to existing configs.
2. **Phase 2 (a1 relevance)**: The `EvaluationContext` is also useful for relevance matching — `recentAssistantMessages` provides the text to score against. The condition system and relevance system can share the same context build.
3. **Future**: Custom conditions registered by other extensions could create cross-plugin triggers (e.g., "remind about deployment rules only when todo-enforcer detects stagnation").
