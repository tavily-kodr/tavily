# Searching Domain (`domains/searching`)

## Overview

The **Searching Domain** is the core retrieval, ranking, and synthesis engine of Tavily. It is engineered to perform web retrieval across multiple underlying search providers, enforce domain filters, eliminate duplicates, compute multi-factor relevance ranking, and synthesize grounded answers with citations.

As defined in the project architecture:
- **Location**: `domains/searching/`
- **Responsibilities**:
  - Search engine query processing & normalization
  - Multi-provider retrieval (DuckDuckGo, SearXNG, Brave, Tavily, Composite Fallback)
  - Multi-factor ranking (relevance, domain authority, freshness decay, content quality)
  - URL and semantic deduplication
  - AI grounded answer synthesis
  - In-memory deterministic caching
  - Unit, integration, and end-to-end search testing

---

## Directory Layout

```text
domains/searching/
├── docs/
│   ├── README.md           # Domain overview and usage guide
│   ├── architecture.md     # Architectural pipeline & boundary specification
│   └── api.md              # Public API and schema reference
├── src/
│   ├── models/             # Data models (SearchOptions, SearchResult, RankingFactors)
│   ├── providers/          # Retrieval providers (DuckDuckGo, SearXNG, Brave, etc.)
│   ├── services/           # Business logic (Search, Ranking, Deduplication, Answer, Cache)
│   ├── utils/              # Text, URL, and concurrency utilities
│   ├── tests/              # Test suites
│   └── index.ts            # Public domain entrypoint
├── package.json
└── tsconfig.json
```

---

## Shared Package Integration

Following Section 37 of `CONTRIBUTING.md`, the Searching domain utilizes:
- `@tavily/logger`: Structured logging across retrieval and ranking lifecycles.
- `@tavily/errors`: Standardized `AppError` handling for query validation and provider errors.
- `@tavily/config`: Centralized environment variable validation.

---

## Provider Strategy

The search pipeline employs a **Composite Provider** architecture with automatic fallbacks:
1. **Primary Keyed Providers**: If configured (`TAVILY_API_KEY`, `BRAVE_API_KEY`, or `SEARXNG_URL`).
2. **Zero-Config Resilient Provider**: DuckDuckGo HTML & Lite parsers with automatic redirect unmasking.
3. **Composite Provider**: Tries primary providers and cascades to fallbacks on timeout or error.

---

## Ranking System

Results are scored on a scale from `0.05` to `0.99` across 5 factors:
1. **Title Relevance (35%)**: Exact query match and token coverage in title.
2. **Content Relevance (25%)**: BM25-inspired term density and frequency.
3. **Source Quality (15%)**: TLD authority (`.gov`, `.edu`, `.org`) and recognized high-authority domains.
4. **Freshness (15%)**: Date decay curve according to specified `time_range` (`day`, `week`, `month`, `year`).
5. **Content Quality (10%)**: Extracted substantive body length vs snippet noise.

---

## Deduplication

1. **Normalized URL Matching**: Strips tracking query parameters (`utm_*`, `gclid`, `fbclid`), normalizes scheme, strips trailing slashes, and removes anchors.
2. **Domain + Path Collapse**: Eliminates redundant redirects within the same path.
3. **Jaccard Content Similarity**: Removes syndicated and duplicate articles using token set overlap above `0.75` threshold.

---

## Running Domain Tests

From repository root:
```bash
pnpm test
```
Or directly within the domain:
```bash
pnpm --filter @tavily/searching test
```
