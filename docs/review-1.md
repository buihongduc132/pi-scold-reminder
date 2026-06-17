# scold-reminder — Plan Review #1

**Reviewer**: review subagent  
**Date**: 2026-06-04  
**Plan**: `flow/intentions/scold-reminder/plan.md`  
**Intention**: `flow/intentions/scold-reminder/intention.md`  
**Reference impl**: `profile/extensions/todo-enforcer/`  

---

## APPROVED

### 1. Hook selection is sound
The plan proposes `session_start` + `message_end` (assistant) + `agent_end`.  
- `message_end` is a confirmed valid pi hook event (used by `immediate-compaction/index.ts:215`).  
- Using `message_end` for turn counting is architecturally correct — it fires per message, giving fine-grained control.  
- `agent_end` as a safety net mirrors todo-enforcer's pattern.  

### 2. Non-blocking by default
All hooks are marked non-blocking with fire-and-forget delivery. This aligns with AGENTS.md rules and the hooks reference (`flow/requirements/hooks/README.md`). No safety-gate justification needed for this extension.

### 3. Mode coverage matches intention spec
All three modes from the intention are addressed:
- **Mode a** (random pool): Step 3, `selector.ts`
- **Mode a1** (contextual matching): Phase 2, Steps 7–9
- **Mode b** (instruction/reminder pairs): Step 5, `session_start` injection + periodic reminders

### 4. Config layering is correct
ENV > global YAML > project YAML > defaults. Same precedence as todo-enforcer's JSON config but using YAML (which is reasonable for human-edited reminder text).

### 5. Delivery modes match todo-enforcer pattern
`pi.sendUserMessage()` as default, `pi.sendMessage()` with customType as alternative — identical to `todo-enforcer/config.ts` `MessageDeliveryConfig` and `deliverMessage()` in `index.ts`.

### 6. Phase 1 is independently shippable
Phase 1 delivers modes a + b with random selection. Mode a1 is additive. Phase 3 features are clearly marked as future work.

### 7. Safety caps are well-designed
`maxInjections` (20), `cooldownMs` (2 min), and the `injectedInstructions` tracker prevent runaway injection.

### 8. Shared library reuse
The plan should use (and implicitly allows) `lib/plugin-logger.ts` and `lib/hooks-manager.ts` — both are established patterns across all extensions.

---

## ISSUES

### I-1. `message_end` role filtering is underspecified
**Location**: Plan Step 5, `message_end` hook description  
**Problem**: The plan says "message_end (assistant role only)" but `message_end` fires for ALL messages (user, assistant, tool results). The implementation must explicitly filter by `event.message.role === "assistant"` to avoid counting user messages and tool results as turns.  
**Evidence**: `immediate-compaction/index.ts` uses `message_end` without role filtering because it checks context usage (role-agnostic). scold-reminder's turn-counting logic is role-dependent.  
**Fix**: Step 5 must specify:
```typescript
pi.on("message_end", async (event, _hookCtx) => {
  if (event.message?.role !== "assistant") return;
  // ... turn counting + injection logic
});
```

### I-2. Mode b instruction injection at `session_start` may race with agent
**Location**: Plan Step 5, `session_start` handler  
**Problem**: The plan says "inject all `pair[].instruction` via `pi.sendUserMessage()`" at `session_start`. But `session_start` fires before the agent begins. `sendUserMessage()` at this point may:
- Get consumed by the user's initial prompt (first turn) — desirable for mode b
- Race with other extensions that also inject at `session_start` (hindsight, gitnexus, etc.)
- Be lost if the agent starts before the message is dispatched  

**Evidence**: todo-enforcer does NOT inject messages at `session_start` — it only loads config and captures session identity. It defers all delivery to `agent_end`.

**Fix**: Consider injecting mode b instructions via the `before_agent_start` or `context` hook instead, which fire after the user's initial prompt but before the LLM begins. Alternatively, use `pi.sendMessage()` with a system-level customType (not `sendUserMessage`) to ensure it's in the context but doesn't trigger a turn.

### I-3. `agent_end` as "safety net" is redundant with `message_end`
**Location**: Plan hooks table + Step 5  
**Problem**: `agent_end` fires once when the agent goes idle. `message_end` fires per message (including the last assistant message). By the time `agent_end` fires, the last `message_end` already ran. The "safety net" scenario (agent went idle and injection was due) would only occur if `message_end` somehow missed the turn — which shouldn't happen if role filtering is correct.  
**Evidence**: todo-enforcer uses `agent_end` as its PRIMARY evaluation hook (it evaluates todo state only when the agent goes idle). scold-reminder uses `message_end` as primary. Adding `agent_end` as backup introduces a dual-evaluation risk.  
**Fix**: Either (a) remove `agent_end` and rely solely on `message_end`, or (b) use `agent_end` only for a deferred check that verifies "last injection was >N turns ago" — not for redundant turn counting.

### I-4. YAML config format deviates from project convention
**Location**: Config Schema section  
**Problem**: All other pi extensions use JSON config files (`.todo-enforcer.json`, `.scold-reminder.json` would follow convention). YAML adds a new dependency (`js-yaml` or `yaml`) and deviates from the established pattern.  
**Evidence**: `todo-enforcer/config.ts` uses JSON parse. `pi-gitnexus-local/config.ts` uses JSON-like. All extensions use JSON.  
**Fix**: Use JSON with comments (strip `//` lines before parse — todo-enforcer already does this in `tryParseJson`). This eliminates the `js-yaml` dependency and keeps config tooling consistent. If YAML is strongly preferred, justify it in the plan.

### I-5. `registerHook()` calls missing from plan
**Location**: Step 5 (index.ts)  
**Problem**: The plan doesn't mention calling `registerHook()` for each hook event. Every extension that uses `lib/hooks-manager.ts` must call `registerHook(extensionName, eventName, opts)` at load time so that `isEnabled()` works correctly.  
**Evidence**: `todo-enforcer/index.ts:571-573`:
```typescript
registerHook("todo-enforcer", "session_start", { blocking: false, source: "pi", origin: "global" });
registerHook("todo-enforcer", "session_shutdown", { blocking: false, source: "pi", origin: "global" });
registerHook("todo-enforcer", "agent_end", { blocking: false, source: "pi", origin: "global" });
```  
**Fix**: Add to Step 5:
```typescript
registerHook("scold-reminder", "session_start", { blocking: false, source: "pi", origin: "global" });
registerHook("scold-reminder", "message_end", { blocking: false, source: "pi", origin: "global" });
registerHook("scold-reminder", "agent_end", { blocking: false, source: "pi", origin: "global" });
```

### I-6. No `session_shutdown` hook for cleanup
**Location**: Hooks table  
**Problem**: The plan registers `session_start` but not `session_shutdown`. Every other extension cleans up state on shutdown (timers, caches, identity). scold-reminder has per-session in-memory state (`turn-tracker.ts`) that should be cleared.  
**Evidence**: `todo-enforcer/index.ts:597-609` has explicit `session_shutdown` handler that calls `cancelPoll()`, `clearSessionIdentity()`, and cleans rule overrides.  
**Fix**: Add `session_shutdown` hook to reset turn tracker state and clear any pending timers.

### I-7. Turn counter logic may inject on turn 0
**Location**: Step 2, `shouldInject` logic  
**Problem**: `turnCount % injectEvery === 0` evaluates to true when `turnCount === 0` (on the very first assistant message). This means an injection fires on the first turn, which is too aggressive and may interfere with the agent's initial response.  
**Fix**: Add a guard: `turnCount > 0 && turnCount % injectEvery === 0`, or start `turnCount` at 1 instead of 0.

### I-8. `injectRandom` threshold behavior is ambiguous
**Location**: Step 2, random variation  
**Problem**: The plan says "if `injectRandom`, use `Math.floor(Math.random() * injectEvery) + 1` as threshold." But this computes a single random threshold at session start. The variable name and description suggest random interval variation, but the logic reads as a fixed random threshold that persists for the entire session.  
**Fix**: Clarify: is this (a) a per-session random offset (fixed threshold, randomized once), or (b) a per-interval random roll (each interval gets a fresh random)? If (b), the logic should be `if injectRandom, inject when Math.random() < 1/injectEvery` on each turn.

---

## SUGGESTIONS

### S-1. Consider `turn_end` instead of `message_end`
`turn_end` fires once per complete turn (all tool calls within a single LLM invocation). This maps more naturally to "every N turns" than `message_end` (which fires per message, including tool results).  
**Tradeoff**: `turn_end` gives coarser granularity. `message_end` with role filtering gives per-message control. The plan's intent is "turn-based" injection, so `turn_end` may be semantically closer.

### S-2. Add `context` hook for mode b instructions
Instead of injecting mode b instructions via `sendUserMessage()` at `session_start`, consider injecting them via the `context` hook. This:
- Keeps instructions in the context window (not as user messages)
- Survives compaction (context hook re-injects after compaction)
- Doesn't pollute the conversation history with "instruction" messages
**Evidence**: `pi-gitnexus-local` and `hindsight-pi` use the `context` hook for this exact purpose — persistent context that survives compaction.

### S-3. Add deduplication to mode a random selection
The plan doesn't mention avoiding repeated selections. A simple "recently used" ring buffer (last 5 selections) would prevent the same reminder appearing twice in a row, which would undermine the "scold" effect (the agent would learn to ignore it).

### S-4. Add a D2 diagram
Per AGENTS.md, `flow/d2/plugins/` should have a `<plugin>.d2` file for every plugin. Add a `scold-reminder.d2` diagram alongside the plan.

### S-5. Consider indicator visibility rules
Per the hooks reference, injection messages via `sendUserMessage()` ARE session-persistent (visible to sub-agents). The plan should explicitly acknowledge this and document that this is intentional (same as todo-enforcer). If mode b instructions are injected via `context` hook instead (S-2), they would also be session-persistent.

### S-6. Test coverage should include integration scenarios
The test plan lists unit tests per module. Add:
- **Cross-mode test**: mode a + mode b active simultaneously, verify both fire correctly
- **Config reload test**: project YAML changes mid-session
- **Disabled state test**: `enabled: false` suppresses all hooks immediately
- **Multi-session isolation test**: two concurrent sessions with independent turn counters

### S-7. Package name convention
The plan proposes `vendor-omo-pi-scold-reminder`. Verify this follows pi's package naming convention (todo-enforcer uses no package name since it's a local extension, not a published package). If this stays local, no package name is needed.

### S-8. Stale-ctx safety
The plan doesn't address the stale-ctx pattern. Todo-enforcer carefully caches `sessionId` and `branch` in `session_start` to avoid accessing stale `ctx` objects in later hooks. scold-reminder must do the same.  
**Fix**: Add to Step 2 (`turn-tracker.ts`) or Step 5 (`index.ts`): cache session identity in `session_start`, use cached values in `message_end`/`agent_end`.

---

## VERDICT: **APPROVE_WITH_CHANGES**

The plan is well-structured, phased correctly, and follows the right architectural patterns. The issues above are implementation details that need clarification before coding begins, not fundamental design flaws.

**Required changes before implementation**:
1. Fix I-1 (role filtering on `message_end`)
2. Fix I-5 (add `registerHook()` calls)
3. Fix I-6 (add `session_shutdown` cleanup)
4. Fix I-7 (guard against turn 0 injection)
5. Address I-2 (mode b injection timing) — either justify `session_start` + `sendUserMessage` or switch to `context` hook
6. Address I-4 (JSON vs YAML) — either switch to JSON or document the rationale

**Recommended but not blocking**:
- S-2 (context hook for mode b instructions) would significantly improve robustness
- S-8 (stale-ctx caching) prevents a known crash pattern
- I-3 (remove redundant `agent_end` or clarify its unique role)