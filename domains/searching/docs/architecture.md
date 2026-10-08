# Searching Domain Architecture

## Architectural Principles

1. **Strict Domain Boundary**:
   - `domains/searching` has zero dependencies on `apps/` or other internal domain implementation details.
   - External dependencies are strictly isolated behind provider interfaces.
   - Shared cross-cutting concerns (logging, configuration, error types) are imported from `packages/`.

2. **Pipeline Architecture**:
   The search lifecycle executes in deterministic sequence:

```text
User Query
    │
    ▼
[ 1. Query Normalization & Validation ]  ──► (AppError on invalid input)
    │
    ▼
[ 2. Cache Lookup ]                      ──► (Return cached response if hit)
    │
    ▼
[ 3. Provider Retrieval Execution ]      ──► (DuckDuckGo / Brave / SearXNG / Tavily)
    │
    ▼
[ 4. Domain Inclusion/Exclusion Filter ]
    │
    ▼
[ 5. URL & Path Deduplication ]
    │
    ▼
[ 6. Semantic Content Similarity Filter]
    │
    ▼
[ 7. Multi-Factor Relevance Ranking ]
    │
    ▼
[ 8. Grounded AI Answer Synthesis ]
    │
    ▼
[ 9. Response Cache Storage ]
    │
    ▼
SearchResponse Output
```

3. **Resilience & Fallbacks**:
   - All external provider calls are protected with timeouts and graceful error boundaries.
   - If an upstream search provider fails or rate-limits, the Composite provider automatically degrades gracefully to alternate backends.
   - Answer synthesis utilizes LLM inference when configured, falling back seamlessly to grounded extractive summary synthesis.
