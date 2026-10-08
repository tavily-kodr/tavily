# Web Search

## Overview

The Web Search feature provides web search aggregation, filtering, and relevance ranking for the Tavily platform. It is exposed as an HTTP service via `@tavily/api` and implemented as a domain package in `domains/searching` (`@tavily/searching`).

The service delegates raw web queries to an upstream, self-hosted [SearXNG](https://github.com/searxng/searxng) metasearch instance. SearXNG fans out requests across multiple search engines concurrently without requiring separate third-party API keys or exposing search traffic to proprietary tracking. The `@tavily/searching` engine normalizes, deduplicates, filters, ranks, and caches the aggregated results into a structured, Tavily-compatible response payload.

### High-Level Request Flow

```text
Client
  │
  ▼
API (GET /search) [apps/api]
  │
  ├── Request validation (Zod schema)
  └── Query delegation
        │
        ▼
Search Service (webSearch) [domains/searching]
  │
  ├── In-memory TTL Cache check
  ├── Upstream parallel fetch (SearXNG pages 1 & 2 via HTTP keep-alive)
  ├── Retry on upstream network failure
  ├── Engine health check (partial/total failure detection)
  ├── Candidate fusion & URL deduplication (RRF normalization)
  ├── Domain filtering (include_domains / exclude_domains)
  ├── Quality scoring (RRF agreement + keyword overlap + authority boost)
  ├── Result partitioning (strict passing vs. low-confidence backfill)
  ├── Slicing to max_results
  └── Cache population (if complete & non-empty)
        │
        ▼
Response JSON (SearchResponse)
```

---

## Architecture

The search implementation is architected with strict boundary separation following monorepo principles:

- **Applications (`apps/api`)**: Responsible for HTTP transport, endpoint routing, request validation, environment configuration loading, error mapping, and HTTP response serialization. Application code never performs direct search ranking or metasearch orchestration.
- **Domains (`domains/searching`)**: Self-contained domain library exposing `webSearch` and associated rank/filter functions. It does not read `process.env`, handle HTTP requests, or depend on `apps/api`. All configuration (SearXNG URL, expected engines, domain filters, limits) is injected via options.
- **Shared Packages (`packages/*`)**:
  - `@tavily/config`: Type-safe environment validation and loading via Zod.
  - `@tavily/errors`: Standardized application error class (`AppError`) with error codes and HTTP status codes.
  - `@tavily/logger`: Structured JSON logging with Winston.
- **Infrastructure (`infrastructure/searxng`)**: Containerized SearXNG deployment and engine configuration files.

---

## Project Structure

```text
apps/api/
├── src/
│   ├── app.ts                  # Express setup, query validation schemas, /search & /health routes
│   ├── app.test.ts             # API integration tests using supertest
│   └── server.ts               # HTTP server bootstrap and port listener
└── package.json

domains/searching/
├── src/
│   ├── cache/
│   │   ├── cache.ts            # In-memory TTL cache
│   │   └── cache.test.ts       # Unit tests for cache expiration
│   ├── dedupe/
│   │   ├── dedupe.ts           # Canonical URL normalization and deduplication
│   │   └── dedupe.test.ts      # Unit tests for URL normalizer
│   ├── filters/
│   │   ├── filters.ts          # Domain inclusion and exclusion filtering
│   │   └── filters.test.ts     # Unit tests for domain matching
│   ├── rank/
│   │   ├── rank.ts             # Reciprocal Rank Fusion (RRF), keyword overlap, and authority boosting
│   │   └── rank.test.ts        # Unit tests for scoring, penalties, and backfill logic
│   ├── searxng/
│   │   └── searxng-client.ts   # SearXNG client, Zod response validation schemas, and page fetching
│   ├── search/
│   │   ├── search-service.ts   # webSearch orchestrator: parallel page fetching, retries, caching
│   │   └── search-service.test.ts # Integration tests for search service, caching, and fallback logic
│   ├── types.ts                # Public search contracts, options, and SearXNG raw response types
│   └── index.ts                # Public exports for the @tavily/searching package
├── docs/
│   ├── README.md               # Web search architecture and integration documentation
│   └── quality.md              # Quality metrics and scoring breakdown
└── package.json

infrastructure/searxng/
├── docker-compose.yml          # Container configuration for SearXNG service
└── searxng-config/
    └── settings.yml            # SearXNG active engines, timeouts, and JSON API configuration
```

---

## API

### GET `/search`

Executes a web search query and returns ranked, deduplicated search results.

#### Query Parameters

| Parameter         | Type                   | Required | Default     | Allowed Values / Constraints            | Description                                                                                                                    |
| :---------------- | :--------------------- | :------- | :---------- | :-------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------- |
| `q`               | `string`               | **Yes**  | —           | Non-empty trimmed string                | The search query text.                                                                                                         |
| `max_results`     | `number`               | No       | `10`        | Integer between `1` and `20`            | Maximum number of results to return.                                                                                           |
| `include_domains` | `string` \| `string[]` | No       | `[]`        | Up to 50 valid domain strings           | Restricts search results to specified domains or their subdomains. Supports comma-separated list or repeated query parameters. |
| `exclude_domains` | `string` \| `string[]` | No       | `[]`        | Up to 50 valid domain strings           | Drops search results from specified domains or their subdomains. Supports comma-separated list or repeated query parameters.   |
| `time_range`      | `string`               | No       | `undefined` | `"day"`, `"week"`, `"month"`, `"year"`  | Filters results by publication/discovery timeframe.                                                                            |
| `topic`           | `string`               | No       | `"general"` | `"general"`, `"news"`                   | Search category partition forwarded to SearXNG.                                                                                |
| `language`        | `string`               | No       | `"en-US"`   | Regex `/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/` | Language code for search localization (e.g. `en`, `en-US`, `fr`).                                                              |

#### Example Request

```bash
curl "http://localhost:3000/search?q=typescript+generics&max_results=5&topic=general&language=en-US&exclude_domains=spam.com"
```

#### Response Structure (`SearchResponse`)

```json
{
  "query": "typescript generics",
  "results": [
    {
      "title": "TypeScript: Documentation - Generics",
      "url": "https://www.typescriptlang.org/docs/handbook/2/generics.html",
      "content": "A major part of software engineering is building components that have well-defined and consistent APIs...",
      "score": 1.0
    },
    {
      "title": "Understanding Generics in TypeScript",
      "url": "https://developer.mozilla.org/en-US/docs/Web/JavaScript",
      "content": "Generics provide a way to create reusable components that can work with a variety of types...",
      "score": 0.82
    },
    {
      "title": "TypeScript Generics Explained with Examples",
      "url": "https://example.com/ts-generics",
      "content": "A comprehensive guide on declaring generic functions and interfaces...",
      "score": 0.45,
      "lowConfidence": true
    }
  ],
  "response_time": 0.382,
  "partial": false,
  "failedEngines": [],
  "filtered": true,
  "enginesUsed": ["bing", "brave", "duckduckgo", "wikipedia"],
  "cached": false
}
```

#### Response Fields

- **`query`** (`string`): The normalized input query.
- **`results`** (`SearchResponseItem[]`): Array of ranked search result objects:
  - `title` (`string`): Extracted title of the web page.
  - `url` (`string`): Canonical URL of the result.
  - `content` (`string`): Extracted text snippet summary.
  - `score` (`number`): Normalized relevance score (`0.0` to `1.0`), sorted descending.
  - `lowConfidence` (`boolean`, optional): Flagged `true` if this result failed one or more quality checks (empty content, non-Latin title on English search, or zero keyword overlap) but was backfilled to satisfy `max_results`.
- **`response_time`** (`number`): End-to-end execution time in seconds.
- **`partial`** (`boolean`): Set to `true` when one or more configured SearXNG engines failed or timed out during the request, but surviving engines returned results.
- **`failedEngines`** (`FailedEngine[]`): List of `{ engine, reason }` entries detailing unresponsive engines.
- **`filtered`** (`boolean`): Set to `true` under normal ranking. Set to `false` when all candidates fail quality checks and the service falls back to raw engine rankings.
- **`enginesUsed`** (`string[]`): Sorted list of engines that contributed at least one candidate result.
- **`cached`** (`boolean`): `true` if served from the in-memory TTL cache; `false` if freshly queried.

---

## Search Pipeline

The search execution pipeline in [`webSearch`](../src/search/search-service.ts) executes the following sequential steps:

1. **Input Validation**: Validates non-empty query string and positive `maxResults`.
2. **Cache Key Generation & Lookup**:
   - Evaluates compound cache key: `[query, maxResults, language, topic, timeRange, sortedIncludeDomains, sortedExcludeDomains]`.
   - Checks the in-memory [`TtlCache`](../src/cache/cache.ts) (5-minute TTL). Returns immediately if hit.
3. **Parallel Multi-Page Upstream Fetch**:
   - Sends concurrent HTTP GET requests to SearXNG for page 1 and page 2 using persistent HTTP/HTTPS agents (`keepAlive: true`) with a 3000ms timeout per page.
   - Tolerates single-page failures if at least one page succeeds.
4. **Upstream Retry**:
   - If both pages fail on the first attempt (connection reset, timeout, 5xx), retries the page requests once before raising an error.
5. **Engine Attribution & Failure Tracking**:
   - Inspects `unresponsive_engines` from SearXNG responses to populate `failedEngines`.
   - If zero results return and all expected engines (`SEARXNG_ENGINES`) are unresponsive, raises a structured `503 ALL_ENGINES_FAILED` error.
6. **Candidate Fusion & Deduplication**:
   - Groups results by normalized URL (lowercase, protocol-agnostic, trailing-slash stripped).
   - Aggregates engine rankings across pages and engines.
   - Computes Reciprocal Rank Fusion score: `RRF = Σ 1 / (60 + engineRank)`.
7. **Hard Domain Filtering**:
   - Applies `excludeDomains` using [`filterBlockedDomains`](../src/filters/filters.ts) to drop matched hosts or subdomains.
   - Applies `includeDomains` using [`filterIncludeDomains`](../src/filters/filters.ts) to restrict results to allowed hosts.
8. **Relevance Scoring & Quality Checks**:
   - Analyzes distinct query keyword overlap against candidate title and snippet (stopwords and standalone numbers removed).
   - Calculates composite score: `0.5 * (RRF / maxRRF) + 0.5 * keywordOverlap`.
   - Multiplies by `1.5x` authority boost for definitional queries (`what is`, `who is`, `how to`) matching official documentation domains (`docs.*`, `wikipedia.org`, `developer.mozilla.org`, etc.).
   - Applies soft penalties rather than dropping:
     - Zero keyword overlap: `0.3x` penalty.
     - Empty snippet content: `0.7x` penalty.
     - Non-Latin script title when language is English: `0.3x` penalty.
9. **Partitioning & Backfill**:
   - Candidates passing all quality criteria are sorted by score.
   - Failing candidates are appended as backfill with `lowConfidence: true`, capped so scores do not exceed the passing threshold floor.
   - If zero candidates pass quality checks, returns all candidates ranked by raw RRF score with `filtered: false`.
10. **Slicing & Cache Storage**:
    - Slices ranked array to requested `max_results`.
    - Stores complete, non-empty, non-partial responses in the TTL cache.

---

## SearXNG

SearXNG acts as the self-hosted metasearch aggregator. It queries public search engine frontends in parallel, parses the output, and returns structured JSON to the service.

### Container Management

SearXNG is defined in `infrastructure/searxng/docker-compose.yml`.

Start the service:

```bash
docker compose -f infrastructure/searxng/docker-compose.yml up -d
```

Check service status:

```bash
docker compose -f infrastructure/searxng/docker-compose.yml ps
```

Stop the service:

```bash
docker compose -f infrastructure/searxng/docker-compose.yml down
```

### Configuration

SearXNG settings are mounted from `infrastructure/searxng/searxng-config/settings.yml`.

Configured active engines:

- **Bing** (General web search)
- **Brave** (Independent web index)
- **DuckDuckGo** (Aggregated web search)
- **Mojeek** (Independent web search crawler)
- **Wikipedia** (Definitional and encyclopedic reference)

Engines with aggressive CAPTCHA or blocking policies (Google, Yahoo, Qwant, Startpage, Yandex, Baidu) are explicitly disabled in `settings.yml` to maintain low latency and predictable response rates.

---

## Configuration

Environment variables are validated on startup via `@tavily/config` Zod schemas.

| Variable          | Scope          | Required        | Default                                  | Description                                                                              |
| :---------------- | :------------- | :-------------- | :--------------------------------------- | :--------------------------------------------------------------------------------------- |
| `PORT`            | API Server     | No              | `3000`                                   | Port on which the Express API server listens.                                            |
| `SEARXNG_URL`     | Search Client  | No              | `http://localhost:8080`                  | URL of the upstream SearXNG service instance.                                            |
| `SEARXNG_ENGINES` | Search Client  | No              | `bing,duckduckgo,brave,mojeek,wikipedia` | Comma-separated list of expected engines. Used to detect total engine outage conditions. |
| `SEARXNG_SECRET`  | SearXNG Docker | Production only | `""`                                     | Secret key used by SearXNG for internal cookie/session encryption.                       |

See `.env.example` in the project root for reference.

---

## Local Development

Ensure Node.js (>=20) and `pnpm` are installed.

### 1. Install Dependencies

From the repository root:

```bash
pnpm install
```

### 2. Configure Environment

Create a `.env` file from `.env.example`:

```bash
cp .env.example .env
```

### 3. Start SearXNG

Launch the containerized SearXNG instance:

```bash
docker compose -f infrastructure/searxng/docker-compose.yml up -d
```

Verify SearXNG is reachable:

```bash
curl "http://localhost:8080/search?q=test&format=json"
```

### 4. Start the API Server

Run the development server with live reload:

```bash
pnpm --filter @tavily/api dev
```

### 5. Verify Endpoints

Health check:

```bash
curl http://localhost:3000/health
```

Search query:

```bash
curl "http://localhost:3000/search?q=rust+lang&max_results=3"
```

---

## Testing

The monorepo uses [Vitest](https://vitest.dev/) for unit and integration testing.

### Run All Tests

```bash
pnpm test
```

Verified test coverage includes:

- **`@tavily/searching`**: 5 test suites, 66 tests covering caching, URL deduplication, domain inclusion/exclusion filtering, RRF fusion, lexical overlap, authority boosting, and multi-page over-fetching.
- **`@tavily/api`**: 1 test suite, 17 tests covering endpoint routing, query parameter schema validation, error mapping, and domain orchestration.

### Code Quality Commands

```bash
# Run ESLint across all workspaces
pnpm lint

# Run TypeScript type verification across all workspaces
pnpm typecheck

# Check Prettier formatting compliance
pnpm format:check

# Format files
pnpm format

# Build production bundles
pnpm build
```

---

## Error Handling

All domain and API exceptions follow structured representations using [`AppError`](../../../packages/errors/src/app-error.ts):

| Scenario                        | HTTP Status                 | Error Code            | Response Payload                                                                                                                  | Description                                                                                                                |
| :------------------------------ | :-------------------------- | :-------------------- | :-------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------- |
| Invalid query params            | `400 Bad Request`           | —                     | `{"error": "<validation_message>"}`                                                                                               | Triggered by Zod validation failures on `q`, `max_results`, domain lists, or enum values.                                  |
| Single/partial engine failure   | `200 OK`                    | —                     | Standard `SearchResponse`                                                                                                         | `partial: true` is set, and failed engines are documented in `failedEngines`. Results from surviving engines are returned. |
| SearXNG network/timeout failure | `502 Bad Gateway`           | `SEARXNG_UNAVAILABLE` | `{"error": "SearXNG request failed after retry: <msg>", "code": "SEARXNG_UNAVAILABLE"}`                                           | Raised when all SearXNG HTTP attempts and retries fail.                                                                    |
| Total upstream engine outage    | `503 Service Unavailable`   | `ALL_ENGINES_FAILED`  | `{"error": "All search engines failed; no results available", "code": "ALL_ENGINES_FAILED", "details": {"failedEngines": [...]}}` | Triggered when SearXNG returns zero results and every expected engine reported an error.                                   |
| Unhandled server error          | `500 Internal Server Error` | `INTERNAL_ERROR`      | `{"error": "Internal server error", "code": "INTERNAL_ERROR"}`                                                                    | Generic handler for unexpected exceptions. In production (`NODE_ENV=production`), internal error details are masked.       |

---

## Design Decisions

1. **Self-Hosted SearXNG Metasearch**:
   - _Rationale_: Provides engine diversification (Bing, Brave, DuckDuckGo, Mojeek, Wikipedia) through a single internal JSON interface without third-party vendor lock-in or per-query API billing.
2. **Domain Isolation (`domains/searching`)**:
   - _Rationale_: Isolates ranking mathematics, fusion algorithms, caching, and upstream HTTP communication from Express route handling. Enables independent testing, profiling, and potential reuse in background jobs or CLI tooling.
3. **Reciprocal Rank Fusion (RRF with $k=60$)**:
   - _Rationale_: Different engines report raw scores on incomparable scales. RRF standardizes rank positions, ensuring URLs verified by multiple distinct engines naturally outrank URLs surfaced by only one engine.
4. **Two-Page Parallel Over-Fetching**:
   - _Rationale_: Fetching pages 1 and 2 concurrently introduces negligible latency overhead due to keep-alive connection reuse, while substantially broadening candidate recall prior to deduplication, filtering, and scoring.
5. **Soft Quality Penalties with Backfill**:
   - _Rationale_: Hard-dropping results that lack snippets or query overlap can leave sparse results for niche or exploratory queries. Penalizing candidates and flagging them as `lowConfidence` guarantees the user receives `max_results` whenever candidates exist, while preserving strict relevance order.
6. **In-Memory TTL Caching (5 Minutes)**:
   - _Rationale_: Search queries follow power-law distribution curves. Caching repeat queries eliminates redundant multi-engine upstream requests, protecting SearXNG from IP rate limits.

---

## Known Limitations

- **Process-Local Memory Cache**: The TTL cache is held in process heap memory. It is not shared across multi-instance API deployments and resets on process restart.
- **Lexical Overlap Without Lemmatization**: Keyword matching uses whitespace and punctuation tokenization without morphological stemming (e.g. `develop` does not automatically match `development`).
- **Datacenter/Docker IP Rate Limiting**: DuckDuckGo and other public engines may intermittently throttle or return CAPTCHAs when SearXNG runs on datacenter or cloud IP ranges.
- **Fixed Two-Page Retrieval**: Every non-cached query fetches two pages regardless of whether `max_results` is small (e.g., 1 or 2).

---

## Future Improvements

- **Distributed Caching**: Introduce Redis-backed caching for horizontal scalability across multiple API replicas.
- **Semantic Reranking / Stemming**: Integrate Porter stemming or lightweight embedding rerankers for semantic query matching.
- **Dynamic Page Fetching**: Fetch page 2 lazily only when page 1 yields fewer unique valid candidates than `max_results`.
- **Adaptive Circuit Breaking**: Implement active circuit breakers per upstream engine to fast-fail engines experiencing extended outages.
