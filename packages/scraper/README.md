# Tavily Scraper

A standalone TypeScript scraper package for fetching and extracting data from permitted public or authorized sources.

## Features

- HTTP fetching with timeout and retry handling
- Automatic JSON and HTML detection
- JSON-path extraction
- CSS-selector HTML extraction
- Page, cursor, and next-link pagination
- Bounded concurrency
- Streaming with backpressure
- Zod-based validation
- Pagination cycle protection
- CLI
- Unit and smoke tests
- Benchmark and measurement scripts

## Package

`@tavily/scraper`

## Requirements

- Node.js >= 20.6
- pnpm

## Commands

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm test:smoke
```

## CLI

```bash
pnpm scrape -- --help
pnpm scrape -- --url https://example.com --mode html
pnpm scrape -- --url https://jsonplaceholder.typicode.com/posts --mode json
```

## Structure

```text
packages/scraper/
├── src/
├── test/
├── scripts/
├── examples/
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

## Scope

The scraper focuses on fetching and extracting data from permitted public or authorized sources.

It does not implement search, authentication, databases, frontend functionality, scheduling, queues, CAPTCHA solving, or anti-bot evasion.
