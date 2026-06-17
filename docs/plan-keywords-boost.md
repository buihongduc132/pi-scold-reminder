# scold-reminder — Relevance Boost System (`keywords` + `boost`)

_Designs how known keywords amplify fuzzy/BM25/embedding scores for mode a1 contextual matching._

## Problem

Mode a1 (contextual matching) picks the most relevant reminder based on recent conversation. But reminder text alone may not contain the right keywords. Example:

- Reminder: "Are you SURE you read the impact analysis before editing? Show proof."
- Agent says: "I'll change the auth handler to use JWT tokens..."
- The reminder is HIGHLY relevant (agent is about to edit code) but the reminder text doesn't contain "change", "auth", "handler", or "JWT"
- Without boost, this reminder might score low on fuzzy/embedding match

**Solution**: Add a `keywords` field to pool items that acts as a **relevance signal amplifier** — separate from the reminder text, feeding into each matching algorithm differently.

---

## Difference from `when`

| Feature | `when` condition | `keywords` boost |
|---------|------------------|------------------|
| Purpose | Hard gate: eligible or not | Soft boost: more likely to be picked |
| Effect | Binary: pass/fail | Continuous: score multiplier |
| Scope | All modes (a, a1, b) | Mode a1 only (fuzzy/BM25/embedding) |
| Evaluation | Before selection | During relevance scoring |
| Without a1 | Still works | Ignored (no relevance scoring) |

---

## Config Schema

### PoolItem with keywords

```typescript
type PoolItem = string | {
  text: string;
  when?: WhenCondition;
  keywords?: string[];      // relevance boost keywords
  boost?: number;           // score multiplier (default: 2.0)
  weight?: number;          // selection frequency weight (default: 1.0)
};
```

### Example

```jsonc
{
  "pool": [
    // Plain string — no boost
    "Did you actually follow ALL the steps in the skills you were told to use?",

    // With keywords — boosted when conversation mentions editing/code changes
    {
      "text": "Are you SURE you read the impact analysis before editing? Show proof.",
      "keywords": ["edit", "change", "modify", "refactor", "rename", "move", "extract", "code", "function", "class", "method"],
      "boost": 2.5
    },

    // With keywords — boosted when conversation mentions bash/shell/deploy
    {
      "text": "Did you run any adhoc commands? That is GATED. Admit it now.",
      "keywords": ["bash", "shell", "command", "run", "execute", "deploy", "rsync", "scp", "sudo"],
      "boost": 2.0
    },

    // With keywords — boosted when agent claims to be done
    {
      "text": "Check your work: did you verify with the verifier-loop skill before claiming done?",
      "keywords": ["done", "complete", "finished", "ready", "all tasks", "works", "passing"],
      "boost": 3.0  // high boost — claiming done without verification is a common failure
    },

    // With keywords — violation language detection
    {
      "text": "I detected corner-cutting. Are you SURE you followed all requirements?",
      "keywords": ["skip", "bypass", "quick", "just use", "shortcut", "simple enough", "don't need", "unnecessary"],
      "boost": 4.0  // highest boost — corner-cutting is the #1 failure mode
    },

    // With keywords — deployment context
    {
      "text": "Did you try to bypass the deploy pipeline? Adhoc deploys are flagged.",
      "keywords": ["deploy", "rsync", "copy", "prod", "staging", "~/.pi", "mise run"],
      "boost": 3.0
    },

    // Minimal boost — general reminder
    {
      "text": "What did you do that was EXPLICITLY instructed NOT TO? Confess.",
      "keywords": ["rule", "instructed", "must", "never", "always", "mandatory", "required"],
      "boost": 1.5
    }
  ]
}
```

---

## How Keywords Feed Into Each Matching Algorithm

### 1. Fuzzy (fuse.js)

**fuse.js supports weighted keys**. Without keywords, we search only the `text` field. With keywords, we add a second key:

```typescript
const fuseOptions = {
  keys: [
    { name: "text", weight: 0.6 },          // the reminder text itself
    { name: "keywordsJoined", weight: 0.4 }, // keywords joined into a single string
  ],
  threshold: config.relevance.fuzzyThreshold,
  includeScore: true,
};

// Pre-process pool items
const fuseItems = pool.map(item => ({
  text: normalizePoolItem(item).text,
  keywordsJoined: (normalizePoolItem(item).keywords ?? []).join(" "),
}));
```

**Effect**: If the conversation context matches a keyword (e.g., "edit"), ALL items containing "edit" in their keywords get a score boost. The `text` weight (0.6) ensures the reminder content still matters, but keywords provide the " topical awareness."

**Boost multiplier**: After fuse.js returns a score (0 = perfect, 1 = no match), apply boost:
```typescript
const adjustedScore = fuseScore / (item.boost ?? 1.0);
// Higher boost → lower adjusted score → higher rank
```

### 2. BM25

BM25 scores documents (pool items) against a query (conversation context). Keywords get **injected as extra document terms with higher frequency**:

```typescript
function buildBm25Document(item: NormalizedPoolItem): string {
  const parts = [item.text];

  // Inject keywords as extra terms (repeated for higher TF weight)
  if (item.keywords && item.keywords.length > 0) {
    const repeatCount = Math.ceil((item.boost ?? 1.0));
    for (let i = 0; i < repeatCount; i++) {
      parts.push(item.keywords.join(" "));
    }
  }

  return parts.join(" ");
}
```

**Effect**: Keywords appear N times in the "document" where N = boost. BM25's TF-IDF naturally ranks items higher when their keywords match query terms.

### 3. Embedding (semantic)

Embedding uses dense vectors. Keywords can be incorporated in two ways:

#### Option A: Keyword-augmented embedding (recommended)

```typescript
function buildEmbeddingText(item: NormalizedPoolItem): string {
  const parts = [item.text];

  if (item.keywords && item.keywords.length > 0) {
    // Append keywords as context — "Topics: edit, change, modify, ..."
    parts.push("Topics: " + item.keywords.join(", "));
  }

  return parts.join("\n");
}
```

Embed the `text + "Topics: keyword1, keyword2, ..."` string. This gives the embedding model explicit signal about the reminder's topical scope.

#### Option B: Dual embedding with weighted cosine

```typescript
// Two separate embeddings per item
const textEmbedding = await embed(item.text);
const keywordEmbedding = await embed(item.keywords.join(" "));

// Weighted combination
const textWeight = 0.6;
const keywordWeight = 0.4 * (item.boost ?? 1.0);

// Score = weighted cosine similarities
const score = textWeight * cosineSim(queryEmb, textEmbedding)
            + keywordWeight * cosineSim(queryEmb, keywordEmbedding);
```

**Recommendation**: Option A is simpler and cheaper (1 embedding call per item instead of 2). The "Topics:" prefix gives the model clear signal. Option B is more precise but doubles embedding API costs.

**Boost as score multiplier** (both options):
```typescript
const finalScore = rawScore * (item.boost ?? 1.0);
```

---

## Score Combination Across Fallback Chain

When the fallback chain is `embedding → bm25 → fuzzy → random`, each level produces a scored list. The final ranking combines:

```typescript
interface ScoredItem {
  item: NormalizedPoolItem;
  source: "embedding" | "bm25" | "fuzzy" | "random";
  rawScore: number;       // algorithm-native score (0-1)
  boostedScore: number;   // rawScore * boost
}

function rankItems(items: NormalizedPoolItem[], context: string, config: RelevanceConfig): ScoredItem[] {
  for (const algorithm of config.fallbackChain) {
    const scored = evaluateWithAlgorithm(algorithm, items, context);
    const aboveThreshold = scored.filter(s => s.rawScore >= (config.fuzzyThreshold ?? 0.6));

    if (aboveThreshold.length > 0) {
      // Apply boost and sort
      return aboveThreshold.map(s => ({
        ...s,
        boostedScore: s.rawScore * (s.item.boost ?? 1.0),
      })).sort((a, b) => b.boostedScore - a.boostedScore);
    }
  }

  // All algorithms failed — random pick
  return [{ item: randomPick(items), source: "random", rawScore: 0, boostedScore: 0 }];
}
```

---

## Pair Reminder Keywords

Pairs can also have keywords on individual reminders:

```jsonc
{
  "pairs": [
    {
      "id": "impact-analysis-mandatory",
      "instruction": "CRITICAL RULE: You MUST run `gitnexus_impact` before editing ANY symbol.",
      "reminders": [
        {
          "text": "Remember: impact analysis is MANDATORY before every edit. Did you run it?",
          "keywords": ["edit", "change", "modify", "refactor", "blast radius", "impact"],
          "boost": 2.5
        },
        "Impact analysis check: when was the last time you ran gitnexus_impact?"
      ]
    }
  ]
}
```

---

## `weight` vs `boost` vs `keywords`

| Field | Purpose | Scope | Default |
|-------|---------|-------|---------|
| `weight` | Selection frequency weight — how often this item is chosen in random mode (a) | Mode a (random) | 1.0 |
| `boost` | Relevance score multiplier — amplifies a1 matching score | Mode a1 (fuzzy/BM25/embedding) | 1.0 |
| `keywords` | Relevance signal terms — fed into matching algorithms | Mode a1 only | `[]` |

**All three are independent**:
- High `weight` + no `keywords`: chosen often in random mode, neutral in a1
- Low `weight` + high `boost` + rich `keywords`: rarely chosen in random, but when a1 is active and conversation is relevant, it scores very high
- No `weight` + no `boost` + no `keywords`: plain string, works everywhere with default behavior

---

## Types Update

```typescript
interface RichPoolItem {
  text: string;
  when?: WhenCondition;
  keywords?: string[];   // relevance boost terms (mode a1 only)
  boost?: number;        // score multiplier, default 1.0 (mode a1 only)
  weight?: number;       // selection frequency, default 1.0 (mode a only)
}

type PoolItem = string | RichPoolItem;

interface NormalizedPoolItem {
  text: string;
  when?: WhenCondition;
  keywords: string[];    // always present after normalization (default: [])
  boost: number;         // always present after normalization (default: 1.0)
  weight: number;        // always present after normalization (default: 1.0)
}

function normalizePoolItem(item: PoolItem): NormalizedPoolItem {
  if (typeof item === "string") {
    return { text: item, keywords: [], boost: 1.0, weight: 1.0 };
  }
  return {
    text: item.text,
    when: item.when,
    keywords: item.keywords ?? [],
    boost: item.boost ?? 1.0,
    weight: item.weight ?? 1.0,
  };
}
```

---

## Implementation Location

This is a **Phase 2** feature — it only matters when mode a1 (relevance matching) is active. In Phase 1, `keywords`, `boost`, and `weight` are parsed and normalized but **not used** during selection (random mode ignores them).

Files affected in Phase 2:
- `types.ts` — add `keywords`, `boost`, `weight` to `RichPoolItem` + `NormalizedPoolItem`
- `selector.ts` — add `selectWeighted()` that uses keywords for each algorithm
- `scold-reminder.example.json` — add example items with keywords

---

## GOTCHAS

### G-K1: Keywords dilution

**Issue**: Too many keywords per item → all items match everything → no differentiation.

**Fix**: Recommend 5-15 keywords per item. Validate and warn if > 20 keywords.

### G-K2: Boost inflation

**Issue**: All items have boost: 5.0 → no relative advantage → same as boost: 1.0.

**Fix**: Default boost is 1.0. Document that boost is relative, not absolute. Only set boost on items that should score above average.

### G-K3: Keywords in random mode

**Issue**: User sets keywords expecting them to work in random mode (a).

**Fix**: Document clearly: keywords only affect mode a1. In random mode, use `weight` instead. Log a note on first injection if keywords are set but mode is "random".

### G-K4: Embedding keyword injection can shift meaning

**Issue**: Appending "Topics: edit, change, modify" to a reminder about "verify before claiming done" shifts the embedding vector away from the original semantic meaning.

**Fix**: Option A uses text + topics in same embedding. If this causes false positives, switch to Option B (dual embedding). Start with Option A for simplicity.

### G-K5: BM25 keyword repetition looks spammy

**Issue**: Repeating keywords N times (where N = boost) is a crude TF manipulation.

**Fix**: Acceptable for a lightweight implementation. If precision matters, use a proper field-level BM25 with separate fields and field weights (like Elasticsearch's multi_match).

### G-K6: Cache invalidation when keywords change

**Issue**: Pre-computed embeddings include keywords. If config reloads with changed keywords, embeddings must be recomputed.

**Fix**: Embedding cache is keyed by item text + keywords. If either changes, re-embed. Cache is per-session (built once at config load).
