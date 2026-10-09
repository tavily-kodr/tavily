# Search API Documentation

This document describes the Search API implementation in the Tavily monorepo under [`domains/searching`](file:///d:/Mern%20Projects/Tavily/tavily/domains/searching).

---

## Search API Overview

The Search API provides a high-performance, structured search endpoint that queries Google via an internal [SearXNG](https://docs.searxng.org/) metasearch engine instance, cleans and normalizes the results, deduplicates URLs, and returns up to `MAX_RESULTS` (default 10) valid unique organic search results with high-resolution execution timing.

### Why SearXNG is Used

- **Privacy & Anonymity**: SearXNG acts as an intermediary metasearch engine between Tavily and upstream engines, preventing Google from tracking client IPs and fingerprints.
- **No Direct Google Scraping**: Avoids fragile direct HTML scraping of Google search result pages or complex anti-bot bypass logic directly in domain services.
- **Standardized Machine Interface**: Provides structured JSON outputs (`format=json`) directly from upstream providers.
- **Configurable Engines**: Allows selecting specific upstream search engines (e.g. `engines=google`) programmatically.

### Search Request Flow

```text
Client
  │ (POST /search with JSON body or GET/POST /search/:query)
  ▼
Route (search.routes.ts)
  ▼
Controller (search.controller.ts)
  │ [Starts high-resolution timer: performance.now()]
  ▼
Search Service (search.service.ts)
  ▼
SearXNG Client (searxng.client.ts)
  │ (HTTP GET <SEARXNG_URL>/search?q=<query>&format=json&engines=google)
  ▼
SearXNG Instance (Docker container on port 8080)
  ▼
Google Search Engine
  ▼
Raw JSON Response
  ▼
Search Service (Normalization, URL validation, Deduplication, Result Capping)
  ▼
Controller
  │ [Computes took_ms = elapsedMs(startTime)]
  ▼
Client Response (JSON)
```

### What the API Returns

The API returns a predictable JSON object containing:

- `success`: Boolean indicator (`true` on success, `false` on failure).
- `data`:
  - `query`: The sanitized query string.
  - `results`: An array of at most `MAX_RESULTS` normalized organic result objects (`title`, `url`, `content`, `score`).
  - `took_ms`: The measured end-to-end server execution time in integer milliseconds.
- `error` (on failure): A structured error object containing `code` and `message`.

---

## Architecture

The searching domain strictly adheres to separation of concerns across layered components:

```text
Client
  ↓
Express Application (app.ts)
  ↓
Route (search.routes.ts)
  ↓
Controller (search.controller.ts)
  ↓
Search Service (search.service.ts)
  ↓
SearXNG Client (searxng.client.ts)
  ↓
SearXNG Container (infrastructure/local/searching/docker/docker-compose.yml)
  ↓
Google Search Engine
```

### Component Responsibilities

| Component             | File                                                                                                                                                                                                                           | Responsibility                                                                                                                                                                                                                |
| :-------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Route**             | [`search.routes.ts`](file:///d:/Mern%20Projects/Tavily/tavily/domains/searching/src/routes/search.routes.ts)                                                                                                                   | Maps incoming HTTP endpoints (`POST /search`, `GET /search/:query`, `POST /search/:query`) to controller actions.                                                                                                             |
| **Controller**        | [`search.controller.ts`](file:///d:/Mern%20Projects/Tavily/tavily/domains/searching/src/controllers/search.controller.ts)                                                                                                      | Extracts query from request body (`query`) or path parameter (`:query`), coordinates high-resolution timing, calls `SearchService`, emits structured logs via `@tavily/logger`, and formats success and error JSON envelopes. |
| **Search Service**    | [`search.service.ts`](file:///d:/Mern%20Projects/Tavily/tavily/domains/searching/src/services/search.service.ts)                                                                                                               | Encapsulates domain logic: validates search input, calls `SearxngClient`, normalizes raw results, validates and canonicalizes URLs, eliminates duplicates, and caps the list to `MAX_RESULTS` valid unique items.             |
| **SearXNG Client**    | [`searxng.client.ts`](file:///d:/Mern%20Projects/Tavily/tavily/domains/searching/src/clients/searxng.client.ts)                                                                                                                | Manages HTTP communication with the upstream SearXNG service, enforces configurable request timeouts (`AbortSignal.timeout`), handles connection issues, parses JSON, and maps low-level errors into domain `AppError` types. |
| **Result Normalizer** | [`search.service.ts`](file:///d:/Mern%20Projects/Tavily/tavily/domains/searching/src/services/search.service.ts) & [`url-validator.ts`](file:///d:/Mern%20Projects/Tavily/tavily/domains/searching/src/utils/url-validator.ts) | Strips unnecessary upstream metadata, validates standard HTTP/HTTPS URL syntax, canonicalizes paths to prevent duplicates, and constructs clean typed outputs.                                                                |
| **Error Handling**    | [`app.ts`](file:///d:/Mern%20Projects/Tavily/tavily/domains/searching/src/app.ts) & [`@tavily/errors`](file:///d:/Mern%20Projects/Tavily/tavily/packages/errors)                                                               | Translates domain errors (`AppError`) and framework errors into standardized JSON responses with corresponding HTTP status codes.                                                                                             |

---

## Tech Stack

The Search API is implemented using the following technologies:

- **TypeScript (6.0.3)**: Strict TypeScript with NodeNext module resolution and exact optional property checks.
- **Node.js (v24.3.0)**: Modern Node runtime with native high-resolution timer (`performance.now()`) and built-in test runner (`node:test`).
- **Express (5.2.1)**: HTTP web framework for routing, middleware, and request handling.
- **pnpm (12.9.1)**: Monorepo package manager with workspace package linking.
- **Turborepo (2.11.7)**: Monorepo build and test orchestration pipeline.
- **SearXNG**: Privacy-focused metasearch engine running via Docker.
- **Google Search Engine**: Upstream search engine accessed through SearXNG (`engines=google`).
- **Docker & Docker Compose**: Containerized execution of SearXNG and the Searching service.

---

## Setup

### 1. Install Dependencies

From the repository root:

```bash
pnpm install
```

### 2. Environment Configuration

Create a `.env` file from `.env.example` in the repository root or configure the environment variables:

```bash
cp .env.example .env
```

Default configuration variables:

```env
# SearXNG Configuration
SEARXNG_URL=http://127.0.0.1:8080
SEARCH_TIMEOUT_MS=5000

# Search API Server
PORT=3000
NODE_ENV=development

# Search Results
MAX_RESULTS=10
```

### 3. Start Local Infrastructure via Docker

Start local SearXNG or the entire local stack using Docker Compose:

```bash
docker compose -f infrastructure/local/searching/docker/docker-compose.yml up -d
```

Verify that the containers are healthy:

```bash
docker ps
```

You should see `tavily-searxng-core` listening on `0.0.0.0:8080->8080/tcp`.

### 4. Build and Start the Search API (Host Development)

Build the packages across the monorepo:

```bash
pnpm build
```

Start the Search API server:

```bash
pnpm --filter @tavily/searching start
```

For live development with auto-reload:

```bash
pnpm --filter @tavily/searching dev
```

### 5. Docker Setup and Execution

The repository maintains an intentional separation between **local development infrastructure** and **production infrastructure**:

- `infrastructure/local/searching/docker/` — Local Searching service and local SearXNG setup.
- `infrastructure/production/searching/` — Production Searching Docker build infrastructure.

#### A. LOCAL DEVELOPMENT

The local Docker setup is consolidated under `infrastructure/local/searching/docker/`. It uses a single Dockerfile (`infrastructure/local/searching/docker/Dockerfile`) with live reload (`pnpm dev`) and mounts domain and workspace package sources for interactive development.

1. **Start Local SearXNG**:

   ```bash
   docker compose -f infrastructure/local/searching/docker/docker-compose.yml up -d
   ```

   To start specifically the SearXNG service:

   ```bash
   docker compose -f infrastructure/local/searching/docker/docker-compose.yml up -d searxng
   ```

2. **Start Local Searching**:

   ```bash
   docker compose -f infrastructure/local/searching/docker/docker-compose.yml up -d searching
   ```

   Or start both services simultaneously:

   ```bash
   docker compose -f infrastructure/local/searching/docker/docker-compose.yml up -d
   ```

3. **Check Container Status**:

   ```bash
   docker compose -f infrastructure/local/searching/docker/docker-compose.yml ps
   ```

4. **View Logs**:

   - Searching service logs:
     ```bash
     docker compose -f infrastructure/local/searching/docker/docker-compose.yml logs -f searching
     ```
   - SearXNG logs:
     ```bash
     docker compose -f infrastructure/local/searching/docker/docker-compose.yml logs -f searxng
     ```

5. **Rebuild Local Searching**:

   When modifying dependencies or container configuration, rebuild and restart the Searching service:

   ```bash
   docker compose -f infrastructure/local/searching/docker/docker-compose.yml build searching
   docker compose -f infrastructure/local/searching/docker/docker-compose.yml up -d searching
   ```

6. **Stop Local Searching**:

   To stop only the Searching service:

   ```bash
   docker compose -f infrastructure/local/searching/docker/docker-compose.yml stop searching
   ```

7. **Start / Stop Local SearXNG**:

   - Start SearXNG:
     ```bash
     docker compose -f infrastructure/local/searching/docker/docker-compose.yml up -d searxng
     ```
   - Stop SearXNG:
     ```bash
     docker compose -f infrastructure/local/searching/docker/docker-compose.yml stop searxng
     ```

8. **Stop Entire Local Stack**:

   ```bash
   docker compose -f infrastructure/local/searching/docker/docker-compose.yml down
   ```

9. **Configure `MAX_RESULTS`**:

   The maximum number of search results returned by the Search API is controlled by the `MAX_RESULTS` environment variable (configured in `.env` or via Docker Compose environment).

   - `MAX_RESULTS=10` → return up to 10 valid unique results.
   - `MAX_RESULTS=5` → return up to 5 valid unique results.
   - `MAX_RESULTS=3` → return up to 3 valid unique results.

   The limit is enforced strictly after URL validation and canonical deduplication. If upstream SearXNG returns fewer valid unique results than `MAX_RESULTS`, the API returns all available valid results without inventing artificial results.

#### B. PRODUCTION

Production infrastructure lives under `infrastructure/production/searching/` containing the multi-stage production Dockerfile ([`infrastructure/production/searching/Dockerfile`](file:///d:/Mern%20Projects/Tavily/tavily/infrastructure/production/searching/Dockerfile)).

- **Build Production Image**:

  ```bash
  docker build -f infrastructure/production/searching/Dockerfile -t tavily-searching:latest .
  ```

- **Run Production Image**:

  ```bash
  docker run -d --name tavily-searching-prod -p 3000:3000 \
    -e PORT=3000 \
    -e NODE_ENV=production \
    -e SEARXNG_URL=http://host.docker.internal:8080 \
    -e MAX_RESULTS=10 \
    --add-host host.docker.internal:host-gateway \
    tavily-searching:latest
  ```

---

## API Usage

The Search API provides two convenient endpoint patterns:

### 1. POST `/search` (JSON Body)

Search via JSON payload containing a `query` string property.

**Headers:**

- `Content-Type: application/json`

**Request Body:**

```json
{
  "query": "best places to visit in India"
}
```

**Request Example:**

```bash
curl -X POST "http://127.0.0.1:3000/search" \
  -H "Content-Type: application/json" \
  -d '{"query": "best places to visit in India"}'
```

### 2. Path-Style `/search/<query>` (GET or POST)

Search directly by providing the query in the URL path (e.g. `http://localhost:3000/search/sheiryans`). Ideal for browser navigation, links, and quick CLI queries.

**Request Examples:**

```bash
# In browser or via GET:
curl "http://127.0.0.1:3000/search/sheiryans"

# Or via POST:
curl -X POST "http://127.0.0.1:3000/search/sheiryans"
```

---

### Example Successful Response (HTTP 200)

```json
{
  "success": true,
  "data": {
    "query": "apnacollege",
    "results": [
      {
        "title": "Apna College",
        "url": "https://www.apnacollege.in/",
        "content": "India's Most Loved Coding Community ❤️ · SigmaX : AI Powered 10X Software Engineer. Start your placement preparation today!",
        "score": 1
      },
      {
        "title": "Courses - Apna College",
        "url": "https://www.apnacollege.in/all-courses",
        "content": "Latest Batches (Ongoing) · Alpha Plus 6.0 (C++) · Alpha Plus Batch 6.0 · Delta 8.0 · Prime: AI/ML Batch · Sigma 10",
        "score": 0.5
      },
      {
        "title": "Apna College - YouTube",
        "url": "https://www.youtube.com/@ApnaCollegeOfficial",
        "content": "Apna College · Complete Placement Preparation: AI Full Stack Web Development + DSA + Aptitude | New SigmaX",
        "score": 0.3333333333333333
      }
    ],
    "took_ms": 477
  }
}
```

---

### Example Error Response (HTTP 400)

```json
{
  "success": false,
  "error": {
    "code": "INVALID_QUERY",
    "message": "Search query is required"
  }
}
```

---

## SearXNG Integration

### Configuration & Request Format

The client connects to SearXNG using:

- **Base URL**: Configured via `SEARXNG_URL` (default: `http://127.0.0.1:8080`).
- **Endpoint**: `/search`
- **Query Parameters**:
  - `q`: URL-encoded search query.
  - `format`: `json` (instructs SearXNG to return a machine-readable JSON object).
  - `engines`: `google` (specifies Google as the engine provider).

Full equivalent upstream URL:

```text
http://127.0.0.1:8080/search?q=apnacollege&format=json&engines=google
```

### Docker Engine Configuration

The SearXNG configuration in [`infrastructure/local/searching/docker/searxng/settings.yml`](file:///d:/Mern%20Projects/Tavily/tavily/infrastructure/local/searching/docker/searxng/settings.yml) specifies:

- JSON format output enabled (`search.formats: [html, json]`).
- Rate limiting disabled for internal programmatic access (`server.limiter: false`).
- Google search backend configured via Google Custom Search Engine (`google_cse`) to reliably deliver Google organic results while bypassing IP blocks on automated queries.

### Result Normalization & Ranking

When SearXNG returns the raw JSON response:

1. **URL Validation**: Every raw result is verified with [`isValidUrl`](file:///d:/Mern%20Projects/Tavily/tavily/domains/searching/src/utils/url-validator.ts). Non-string, malformed, or non-HTTP/HTTPS URLs (such as `ftp://`, `javascript:`, or empty hostnames) are immediately discarded.
2. **Duplicate Removal**: Each URL is canonicalized (normalizing scheme and host case, stripping redundant trailing slashes). If a URL has already been recorded, subsequent duplicates are skipped.
3. **Ranking Preservation**: Results are processed strictly in the order provided by SearXNG, preserving the natural search relevance ranking.
4. **Field Sanitization**: Only clean, strongly typed fields (`title`, `url`, `content`, `score`) are extracted. Upstream internal metadata (e.g., `parsed_url`, `positions`, `engine`, `category`, `open_group`) are discarded.
5. **Result Capping**: The normalized list is capped at a maximum of `MAX_RESULTS` items (default 10). If upstream SearXNG returns fewer valid unique results than `MAX_RESULTS`, all available valid results are returned without inventing results.

---

## Performance

### How Execution Time is Measured

Execution time is measured using Node.js high-resolution timer (`performance.now()`). Timing begins immediately upon entering the controller handler and concludes once search results are normalized and prepared for serialization. The duration is converted to integer milliseconds and returned in the `took_ms` field.

$$\text{took\_ms} = \max(0, \operatorname{round}(\text{performance.now}() - \text{startTime}))$$

### Actual Measured Latency From Testing

The following latency metrics were captured during active local testing against the local SearXNG Docker container on Windows 11:

- **Test Environment**: Windows 11 (Node.js v24.3.0, Docker Desktop with WSL2 engine)
- **SearXNG Location**: Local Docker container (`http://127.0.0.1:8080`)
- **Engine Used**: Google via SearXNG (`format=json&engines=google`)
- **Results Tested**: Up to 10 results per query

#### Observed Query Measurements

| Query                           |  Method  | Results Returned | Server `took_ms` | Total Client HTTP Roundtrip | Status |
| :------------------------------ | :------: | :--------------: | :--------------: | :-------------------------: | :----: |
| `best places to visit in India` |   POST   |        10        |   **1102 ms**    |           1120 ms           | 200 OK |
| `apnacollege`                   |   POST   |        10        |    **477 ms**    |           492 ms            | 200 OK |
| `sheiryans`                     | GET path |        10        |    **421 ms**    |           436 ms            | 200 OK |
| `apnacollege` (subsequent)      |   POST   |        10        |   **4491 ms**    |           4510 ms           | 200 OK |

#### Statistical Summary

- **Average Search Latency (normal queries)**: **~666 ms** (well below the < 3.0s target)
- **Minimum Observed Search Latency**: **421 ms**
- **Maximum Observed Search Latency**: **4,491 ms**
- **Internal Application Processing Time**: **< 2 ms** (URL parsing, regex canonicalization, JSON building)
- **Search Provider Latency**: Accounts for **> 98%** of total execution time.

---

## Error Handling

All errors adhere to the standard Tavily error schema:

```json
{
  "success": false,
  "error": {
    "code": "<ERROR_CODE>",
    "message": "<Human-readable description>"
  }
}
```

### Supported Error Codes

| Error Code                    |        HTTP Status        | Trigger Condition                                                                             | Example Message                                              |
| :---------------------------- | :-----------------------: | :-------------------------------------------------------------------------------------------- | :----------------------------------------------------------- |
| `INVALID_QUERY`               |     `400 Bad Request`     | Request body missing `query`, or `query` is empty, only whitespace, or non-string.            | `"Search query is required"`                                 |
| `INVALID_REQUEST`             |     `400 Bad Request`     | Request body contains malformed JSON.                                                         | `"Malformed JSON payload in request body"`                   |
| `SEARCH_PROVIDER_UNAVAILABLE` | `503 Service Unavailable` | SearXNG instance unreachable (e.g. Docker container stopped, network error, or 5xx response). | `"Search provider is unavailable"`                           |
| `SEARCH_TIMEOUT`              |   `504 Gateway Timeout`   | SearXNG request exceeds configured timeout (`SEARCH_TIMEOUT_MS`).                             | `"Search provider request timed out"`                        |
| `INVALID_SEARCH_RESPONSE`     |     `502 Bad Gateway`     | SearXNG returns non-JSON or response missing the `results` array.                             | `"Invalid search response structure received from provider"` |
| `NOT_FOUND`                   |      `404 Not Found`      | Requested route does not exist.                                                               | `"Endpoint not found"`                                       |

---

## Directory Structure

```text
tavily/
├── domains/
│   └── searching/
│       ├── docs/
│       │   └── search-api.md                     # Comprehensive developer documentation
│       ├── src/
│       │   ├── clients/
│       │   │   ├── index.ts                      # Client module exports
│       │   │   └── searxng.client.ts             # Upstream SearXNG HTTP communication & timeout handling
│       │   ├── controllers/
│       │   │   ├── index.ts                      # Controller module exports
│       │   │   └── search.controller.ts          # HTTP query resolution, timing measurement & logging
│       │   ├── routes/
│       │   │   ├── index.ts                      # Route module exports
│       │   │   └── search.routes.ts              # Express router definition (POST /search, /search/:query)
│       │   ├── services/
│       │   │   ├── index.ts                      # Service module exports
│       │   │   └── search.service.ts             # Normalization, URL validation, deduplication, result capping
│       │   ├── types/
│       │   │   ├── index.ts                      # Type module exports
│       │   │   └── search.types.ts               # TypeScript interfaces & response types
│       │   ├── utils/
│       │   │   ├── index.ts                      # Utility module exports
│       │   │   ├── timing.ts                     # High-resolution timing helpers
│       │   │   └── url-validator.ts              # URL verification and canonicalization
│       │   ├── app.ts                            # Express application setup & middleware configuration
│       │   ├── config.ts                         # Zod-validated configuration loader (@tavily/config)
│       │   ├── index.ts                          # Public module entry point
│       │   └── server.ts                         # Standalone HTTP server runner
│       ├── test/
│       │   ├── search.api.test.ts                # End-to-end API integration tests
│       │   ├── search.client.test.ts             # SearXNG client unit tests
│       │   └── search.service.test.ts            # SearchService normalization & deduplication tests
│       ├── .env.example                          # Environment variable template
│       ├── package.json                          # Package definition & scripts
│       └── tsconfig.json                         # TypeScript compiler configuration
│
└── infrastructure/
    ├── local/
    │   └── searching/
    │       └── docker/
    │           ├── .env.example                  # Local Docker environment variable template
    │           ├── Dockerfile                    # Single local Searching container Dockerfile (dev)
    │           ├── docker-compose.yml            # Local Docker Compose (Searching + SearXNG)
    │           └── searxng/
    │               └── settings.yml              # Local SearXNG engine configuration
    │
    └── production/
        └── searching/
            └── Dockerfile                        # Multi-stage production Searching Dockerfile
```

---

## Development

### Running the API Locally

1. Start SearXNG via Docker:
   ```bash
   docker compose -f infrastructure/local/searching/docker/docker-compose.yml up -d searxng
   ```
2. Start the Search API dev server:
   ```bash
   pnpm --filter @tavily/searching dev
   ```

### Running Tests

Execute the automated test suite across the monorepo:

```bash
pnpm test
```

Or run tests specifically for the searching domain:

```bash
pnpm --filter @tavily/searching test
```

### Type Checking

Verify TypeScript typing:

```bash
pnpm --filter @tavily/searching typecheck
```

### Code Formatting and Linting

```bash
pnpm lint
pnpm format:check
```

### Building

Compile TypeScript to `dist/`:

```bash
pnpm --filter @tavily/searching build
```

---

## Limitations

During development and testing against SearXNG and Google, the following limitations were observed:

1. **SearXNG Dependency**: The Search API requires an active SearXNG instance. If the container or remote service is down, requests will fail with `503 SEARCH_PROVIDER_UNAVAILABLE`.
2. **Google Rate Limiting & Bot Detection**: Rapid, burst querying (e.g. more than 5 requests/second) against Google through SearXNG can trigger upstream Google CSE / WML rate limits or temporary engine suspension (`"Suspended: access denied"` in SearXNG), causing subsequent queries to return empty results until the suspension expires.
3. **Upstream Latency Variance**: While internal processing is sub-millisecond, upstream Google network latency and SearXNG engine parsing introduce latency variance between 400 ms and ~4.5 seconds depending on Google's response time and network conditions.
4. **Result Count Capping**: Upstream Google engines occasionally return fewer than 10 organic results for obscure queries. The Search API returns at most 10 results, but may return fewer if fewer organic results are available upstream.
