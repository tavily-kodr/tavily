# Tavily

Tavily is a scalable, domain-driven monorepo designed to support search, scraping, realtime systems, and security-related capabilities.

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

## Development

### Install Dependencies

```bash
pnpm install
```

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
