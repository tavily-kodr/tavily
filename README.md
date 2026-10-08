# Tavily AI Search Engine (`domains/searching`)

Welcome to the **Tavily Monorepo**. This workspace contains the **Searching Domain** implementation (`domains/searching/`) along with shared core packages (`packages/`) and the application orchestration layer (`apps/web/`).

---

## Repository Architecture

```text
tavily/
├── apps/
│   └── web/                   # Next.js Web Search Application & Dashboard
│
├── domains/
│   ├── scraping/              # Scraping Domain (Scraping team)
│   │   ├── docs/
│   │   └── src/
│   │
│   ├── searching/             # Searching Domain (Madhu & Searching team)
│   │   ├── docs/
│   │   │   ├── README.md      # Searching domain guide
│   │   │   ├── architecture.md # Pipeline architecture & boundaries
│   │   │   └── api.md         # API interface specifications
│   │   └── src/
│   │       ├── models/        # Search & Ranking data types
│   │       ├── providers/     # DuckDuckGo, SearXNG, Brave, Tavily, Composite
│   │       ├── services/      # Search, Ranking, Deduplication, Answer, Cache
│   │       ├── utils/         # Tokenization, URL normalization, concurrency
│   │       ├── tests/         # Unit & integration test suites
│   │       └── index.ts       # Public domain exports
│   │
│   ├── realtime/              # Realtime Domain (Realtime team)
│   │   ├── docs/
│   │   └── src/
│   │
│   └── security/              # Security Domain (Security team)
│       ├── docs/
│       └── src/
│
├── packages/
│   ├── config/                # @tavily/config (Env loading & validation)
│   ├── errors/                # @tavily/errors (Shared AppError)
│   └── logger/                # @tavily/logger (Structured logging)
│
├── infrastructure/            # Infrastructure integrations
│
├── CONTRIBUTING.md            # Workflow, branch strategy, review rules
├── pnpm-workspace.yaml        # Workspace configuration
└── package.json               # Root scripts
```

---

## Searching Domain Features

- **Multi-Provider Retrieval**:
  - `DuckDuckGoProvider`: Zero-config live web search with fallback.
  - `BraveSearchProvider`: High-throughput web indexing via Brave API.
  - `SearxngSearchProvider`: Self-hosted meta-search integration.
  - `TavilySearchProvider`: Upstream Tavily API adapter.
  - `CompositeSearchProvider`: Automatic multi-tier fallback.
- **Query Processing & Depth**:
  - `basic`: Direct high-speed retrieval.
  - `advanced`: Query expansion with complementary sub-queries.
- **Domain Filtering**: Granular `include_domains` and `exclude_domains`.
- **Deduplication Engine**: Normalized URL stripping tracking parameters (`utm_*`, `fbclid`, `gclid`), path normalization, and Jaccard token similarity deduplication (`>0.75`).
- **Multi-Factor Ranking Engine**: 5-factor scoring model:
  1. Title relevance (35%)
  2. Content relevance (25%)
  3. Domain authority & TLD scoring (15%)
  4. Freshness & date decay (15%)
  5. Content quality & completeness (10%)
- **Grounded AI Answering**: Extractive & LLM-based answer generation strictly grounded in retrieved citations.
- **Deterministic Caching**: In-memory TTL cache with LRU cleanup.

---

## Standard Repository Checks

Follow the contribution guidelines in [CONTRIBUTING.md](file:///c:/Users/user/Desktop/Tavily/CONTRIBUTING.md):

```bash
# Run test suite
pnpm test

# Run type check
pnpm typecheck

# Run linter
pnpm lint

# Start development UI
pnpm dev
```

---

## Contribution & Git Workflow

- **Domain Assignment**: `domains/searching/`
- **Branch Strategy**:
  - Working branch: `searching/working/madhu`
  - Stage branch: `searching/stage/madhu`
- **Workflow**: `Working → Stage → Pull Request → Siddhant Review → main`
- **Golden Rules**:
  - Always develop in `domains/searching/`
  - Never push directly to `main`
  - Create Pull Requests from the stage branch
