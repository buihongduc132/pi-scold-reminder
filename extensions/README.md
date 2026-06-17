# Extension placeholder

The extension entry point is **not yet implemented**. This directory is reserved
for the Phase 1 implementation described in [`docs/plan.md`](../docs/plan.md).

Planned files (per plan):

```
extensions/
├── index.ts              ← entry point: hooks, orchestration
├── config.ts             ← JSON config loader + types + deep merge + ENV overrides
├── types.ts              ← all TypeScript interfaces
├── conditions.ts         ← condition evaluator: when gate for pool items + pairs
├── context-builder.ts    ← builds EvaluationContext from session branch (lazy)
├── selector.ts           ← embedding cosine selection + random fallback + dedup
├── embedder.ts           ← embedding client: embed, cache, cosine similarity, fallback
└── turn-tracker.ts       ← turn counting, cooldown, injection state, dedup ring buffer
```

See `docs/plan.md` → "Implementation Steps" for the full breakdown.
