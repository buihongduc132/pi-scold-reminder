# scold-reminder — Design Documentation

This directory holds the complete design history for the `scold-reminder` pi
extension, moved verbatim from its origin in a private monorepo.

## Doc lineage (read in this order)

| File | Role | Status |
|------|------|--------|
| [`intention.md`](intention.md) | Original product intent — what & why | Seed |
| [`review-1.md`](review-1.md) | Architectural review of the intention | Superseded by v4 |
| [`review-2.md`](review-2.md) | Config-parity review of the intention | Superseded by v4 |
| [`review-alignment.md`](review-alignment.md) | Intention-alignment audit (95%) | Superseded by v4 |
| [`plan-conditions.md`](plan-conditions.md) | The `when` conditional-trigger system design | Folded into v4 |
| [`plan-keywords-boost.md`](plan-keywords-boost.md) | Keyword-boost + relevance design | Folded into v4 |
| [`review-v4-alignment.md`](review-v4-alignment.md) | v4 alignment audit | Final |
| [`review-v4-arch.md`](review-v4-arch.md) | v4 architecture review | Final |
| [`review-v4-parity.md`](review-v4-parity.md) | v4 config-parity review | Final |
| **[`plan.md`](plan.md)** | **Final implementation plan (v4 — embedding always-on)** | **Canonical** |

`plan.md` is the source of truth. The `review-*` and `plan-*` files are the
design history that produced it — kept for provenance.

## Provenance note for public readers

These docs were authored inside a private monorepo (`pi-plugins`) alongside
sibling pi extensions. Some internal references are preserved verbatim for
design provenance:

- Paths like `profile/extensions/scold-reminder/`, `profile/extensions/todo-enforcer/`,
  `flow/requirements/...`, `flow/d2/...`, and `AGENTS.md` point to **sibling
  artifacts in that monorepo**, not to files in this repo. The extension in
  *this* repo lives at [`../extensions/`](../extensions/).
- `todo-enforcer`, `session-title-interval`, `pi-gitnexus-local` are referenced
  as **reference implementations** of the pi extension pattern — they are
  well-known public-pattern extensions, used here only as design comparison.
- References to "the Nomad cluster", "Caddy proxy", "Hindsight (:24300)" describe
  the **original author's deployment environment** for the embeddings backend;
  this repo is deployment-agnostic — point `relevance.embeddingEndpoint` at your
  own OpenAI-compatible embeddings service (e.g. a self-hosted
  [TEI](https://github.com/huggingface/text-embeddings-inference)).

## Security scrub performed on move

The following internal details were scrubbed before public publishing (the only
changes made during the move; all content is otherwise byte-identical to source):

- Internal tailnet IP `100.114.135.99:8004` → `localhost:8004` (TEI endpoint example)
- `noco-mesh` / `tailnet` infra-topology wording → generic phrasing
- One config comment in `plan.md` about a reverse-proxy deployment reworded

## Dangling reference

`plan.md` cites a `research-libs.md` prior artifact (a 763-line library survey).
That file was a **private working note that does not exist in the committed
source** and was therefore not transferred. Its conclusion is captured in
`plan.md` → "Dependencies": **zero npm dependencies, embeddings via HTTP only,
TEI chosen over BM25/minisearch** — so no technical decision is lost.
