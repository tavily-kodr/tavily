# Searching Domain

Web search domain powered by [SearXNG](https://docs.searxng.org/).
Exposes a direct callable `search()` function for other domains (e.g., scraping).

## Quick Start

### 1. Start SearXNG

The Docker container is managed under `infrastructure/searxng`:

```bash
cd infrastructure/searxng
docker compose up -d
```

### 2. Run / Build

From repository root:

```bash
pnpm --filter @tavily/searching build
```

### 3. Usage

```ts
import { search } from "@tavily/searching";

const response = await search("TypeScript monorepo architecture");
console.log(response.results);
```

## Configuration

Set via environment variables:

- `SEARXNG_BASE_URL` (default: `http://localhost:8080`)
- `SEARXNG_TIMEOUT_MS` (default: `10000`)
- `SEARXNG_MAX_RETRIES` (default: `2`)
