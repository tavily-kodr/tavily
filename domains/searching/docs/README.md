# Searching domain

Web search module: query -> deduplicated list of candidate URLs + snippets.

- `src/searchService.ts` – `webSearch(query, numResults)` calls the self-hosted SearXNG JSON API
  (`config.SEARXNG_URL`), retries once on failure, maps, dedupes, limits and caches results (5 min TTL).
- `src/dedupe.ts` – URL-based dedupe (ignores scheme, case, trailing slash).
- `src/cache.ts` – in-memory TTL cache (per process, resets on restart).
- `src/types.ts` – public result types and the subset of the SearXNG response we use.

Public API is exported from `src/index.ts`. This domain must not import from `apps/`.
SearXNG itself is configured in `infrastructure/searxng/`.
