# Tavily

Tavily is a scalable, domain-driven monorepo designed to support search, scraping, realtime systems, and security-related capabilities.

> **📖 Full API & Team Contribution Guide:** See [API & Contribution Guide](docs/API_AND_CONTRIBUTION_GUIDE.md) for complete JSON contracts, parallel crawler architecture, and team workflows.

## Architecture

```text
tavily/
├── apps/
│
├── domains/
│   ├── scraping/
│   │   ├── docs/
│   │   └── src/
│   │
│   ├── searching/
│   │   ├── docs/
│   │   └── src/
│   │
│   ├── realtime/
│   │   ├── docs/
│   │   └── src/
│   │
│   └── security/
│       ├── docs/
│       └── src/
│
├── packages/
│   ├── config/
│   ├── errors/
│   └── logger/
│
└── infrastructure/
```

## Domains

### Scraping

Responsible for crawling, scraping, extraction, parsing, and other web-content processing capabilities.

### Searching

Responsible for search, retrieval, ranking, and search-related business logic.

### Realtime

Responsible for realtime communication and event-driven capabilities such as:

- WebSockets
- Webhooks
- Triggers
- Realtime events

### Security

Responsible for security-related capabilities such as:

- Bot detection
- CAPTCHA handling
- Authentication and security mechanisms
- Anti-abuse systems

## Shared Packages

Shared packages contain generic, reusable functionality that can be consumed across domains and applications.

- `@tavily/config` — configuration and environment handling
- `@tavily/errors` — shared application error types
- `@tavily/logger` — structured application logging

## Infrastructure

The `infrastructure/` directory contains integrations with external systems and infrastructure services.

Infrastructure concerns should remain isolated from domain business logic.

## Quick Start (New User Setup)

### 1. Prerequisites

- **Node.js**: v20.x or v22.x+
- **pnpm**: `npm install -g pnpm@12.9.1`
- **Docker Desktop**: Running locally (for SearXNG meta-search provider)

### 2. Install Dependencies

```bash
# Install monorepo dependencies
pnpm install

# (Optional) Install Playwright browser for JS-rendered SPA scraping
npx playwright install chromium
```

### 3. Start Search Engine Infrastructure (Docker)

SearXNG provides local privacy-first search aggregation over Google and Bing on port `8080`.

```bash
# Start SearXNG container in the background
pnpm docker:up

# Check container status
pnpm docker:ps

# View SearXNG logs
pnpm docker:logs

# Stop Docker when finished
pnpm docker:down
```

> **Note:** If Docker is not running, the system automatically falls back to an organic web search resolver, ensuring search requests never hard-fail.

### 4. Start the Unified API Orchestrator

The unified orchestrator runs at **`http://localhost:4000`**, bridging searching and high-concurrency scraping into a single pipeline.

```bash
pnpm dev
```

### 5. Test Search & Scraping

- **Search & Parallel Crawl (5 URLs, depth 5):**
  ```bash
  curl "http://localhost:4000/?q=LLM&crawl=true&max_url=5&max_depth=5"
  ```
- **Search only:**
  ```bash
  curl "http://localhost:4000/search?query=machine+learning"
  ```
- **Crawl & Extract direct URL:**
  ```bash
  curl -X POST http://localhost:4000/crawl \
    -H "Content-Type: application/json" \
    -d '{"url":"https://example.com","limit":3}'
  ```
- **View latest generated Markdown file:**
  ```bash
  curl http://localhost:4000/latest_crawl.md
  ```

---

## Development Commands

### Monorepo Services

```bash
# Start Unified API Orchestrator (Port 4000)
pnpm dev

# Start Searching domain standalone (Port 3000)
pnpm dev:search

# Start Scraping domain standalone (Port 3001)
pnpm dev:scrape

# Run CLI scraper directly
pnpm scrape:cli --url https://example.com
```

### Code Quality & Testing

### Run Lint

```bash
pnpm lint
```

### Run Type Checking

```bash
pnpm typecheck
```

### Check Formatting

```bash
pnpm format:check
```

### Format Code

```bash
pnpm format
```

### Run Tests

```bash
pnpm test
```

### Build

```bash
pnpm build
```

## Project Structure Principles

The repository follows a clear dependency direction:

```text
apps
  ↓
domains
  ↓
packages / infrastructure
```

## Rules

- Applications are responsible for orchestration.
- Domains contain business and domain-specific logic.
- Domains must not import application code.
- Domains should not directly depend on another domain's internal implementation.
- Generic reusable functionality belongs in `packages/`.
- External system integrations belong in `infrastructure/`.
- Domain directories remain language-neutral until their implementation language is decided.
- Domain-specific business logic must stay within its owning domain.

## Documentation

Repository contribution guidelines, branching strategy, development workflow, testing requirements, code review process, and other contribution rules are documented in:

```md
CONTRIBUTING.md
```

## Package Manager

This repository uses [pnpm](https://pnpm.io/) as its package manager.

## Monorepo

The repository uses [Turborepo](https://turbo.build/repo) to manage tasks across the monorepo.

Common tasks include:

```bash
pnpm lint
pnpm typecheck
pnpm format:check
pnpm test
pnpm build
```
