# Contributing to Tavily

Welcome to the Tavily monorepo.

This document defines the development workflow, repository structure, branch strategy, testing process, pull request process, code review process, and contribution rules for the project.

The goal is to keep development organized, maintain clear ownership, and make sure only reviewed and tested code reaches `main`.

---

## 1. Project Architecture

The Tavily repository is organized as a monorepo.

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

## 2. Directory Responsibilities

### `apps/`

Application and orchestration layer.

Applications are responsible for composing domains and exposing application-level functionality.

Do not put core domain logic directly inside `apps/` when that logic belongs to a domain.

### `domains/`

Contains the core business/domain logic.

Current domains:

```text
domains/
├── scraping/
├── searching/
├── realtime/
└── security/
```

Each domain owns its own implementation.

### `packages/`

Contains reusable shared packages.

Current shared packages:

```text
packages/
├── config/
├── errors/
└── logger/
```

#### `@tavily/config`

Responsible for:

- Environment variable loading
- Environment variable validation

#### `@tavily/errors`

Contains the shared:

- `AppError`

#### `@tavily/logger`

Contains the shared structured logger.

Shared functionality should not be duplicated inside individual domains.

### `infrastructure/`

Contains integrations with external infrastructure and systems.

Examples may include:

- External services
- Cloud infrastructure
- Databases
- Queues
- Storage
- Infrastructure clients

Infrastructure-specific implementation should remain separated from core domain logic.

## 3. Domain Structure

Each domain currently follows:

```text
domain/
├── docs/
└── src/
```

Example:

```text
domains/scraping/
├── docs/
└── src/
```

The `src/` directory contains the actual implementation.

The `docs/` directory contains domain-specific documentation.

## 4. Scraping Domain

Location:

```text
domains/scraping/
```

Responsible for scraping-related functionality.

Examples:

- Crawling
- Scraping
- Extraction
- Parsing
- Scraping performance
- Scraping approaches
- Scraping API/data handling
- Scraping-related implementation

The scraping domain may interact with the security domain when bot detection, CAPTCHA, authentication bypass, or similar requirements are involved.

## 5. Searching Domain

Location:

```text
domains/searching/
```

Responsible for search-related functionality.

Examples:

- Search engine functionality
- Search
- Retrieval
- Ranking
- Search performance
- Search approaches
- Search testing
- End-to-end search testing

## 6. Realtime Domain

Location:

```text
domains/realtime/
```

Responsible for realtime functionality.

Examples:

- Realtime triggers
- Webhooks
- WebSockets
- Scheduled triggers
- Event-based triggers
- Reflecting data changes
- Realtime performance

## 7. Security Domain

Location:

```text
domains/security/
```

Responsible for security-related functionality.

Examples:

- Bot detection
- CAPTCHA handling
- Authentication bypass
- Security bypass
- Anti-bot mechanisms
- Security-related scraping requirements

## 8. Domain Language

Domains are intentionally language-neutral.

A domain may use:

- TypeScript
- Go
- Python
- Rust
- or another appropriate language

Do not assume that every domain uses TypeScript.

Do not create language-specific configuration until the implementation language for that domain has been decided.

For example, do not automatically create:

- `package.json`
- `tsconfig.json`
- `go.mod`
- `Cargo.toml`

inside a domain before the domain's implementation language has been decided.

## 9. Domain Boundaries

Domains should remain as independent as possible.

### Rules

- Domains must not import code from `apps/`.
- Domain-specific logic must remain inside its own domain.
- Do not directly depend on another domain's internal implementation.
- Reusable generic functionality belongs in `packages/`.
- External infrastructure integrations belong in `infrastructure/`.
- Avoid unnecessary cross-domain dependencies.
- Do not introduce architectural dependencies without discussion.
- Do not move code between domains without discussing the change.

The goal is to keep the domains independently maintainable.

## 10. Team Domain Responsibilities

The current domain responsibilities are organized as follows.

### Scraping

Team members working on scraping include:

- Naitik
- Yash
- Piyush
- Siddhant
- Aniket
- Shiv
- Swagat
- Anand
- Sujal

Scraping-related work should be developed under:

```text
domains/scraping/
```

### Searching

Team members working on searching include:

- Sujal
- Yash
- Madhu
- Hamza
- Adnan
- Piyush
- Rizwan

Searching-related work should be developed under:

```text
domains/searching/
```

### Realtime

Team members working on realtime include:

- Abhijeet
- Deep
- Sajal
- Surya
- Dhruv
- Smit
- Harsh

Realtime-related work should be developed under:

```text
domains/realtime/
```

### Security

Team members working on security include:

- Balaji
- Ankita
- Nameesh

Security-related work should be developed under:

```text
domains/security/
```

## 11. Management and Merge Responsibility

The repository maintainer is:

**Siddhant Mul**

The maintainer is responsible for:

- Reviewing pull requests
- Reviewing implementation quality
- Reviewing architecture
- Requesting changes
- Approving or rejecting changes
- Performing the final merge into `main`

Developers should not merge their own PRs.

Developers are responsible for writing, testing, and pushing their own code.

## 12. Branch Strategy

Every contributor uses two branches per feature or development task.

1. Working branch
2. Stage branch

The branch naming convention is:

```text
<domain>/working/<contributor-name>
<domain>/stage/<contributor-name>
```

The domain identifies the area of the repository being worked on.

If more specific identification is useful, a work type may be added:

```text
<domain>/<work-type>/working/<contributor-name>
<domain>/<work-type>/stage/<contributor-name>
```

Example:

```text
scraping/crawling/working/yash
scraping/crawling/stage/yash
```

For normal domain-level work, prefer the shorter convention.

## 13. Branch Naming Examples

For Yash working on scraping:

```text
scraping/working/yash
scraping/stage/yash
```

For Sujal working on searching:

```text
searching/working/sujal
searching/stage/sujal
```

For Balaji working on security:

```text
security/working/balaji
security/stage/balaji
```

For Abhijeet working on realtime:

```text
realtime/working/abhijeet
realtime/stage/abhijeet
```

## 14. Working Branch

The working branch is the primary development branch for a contributor.

Example:

```text
scraping/working/yash
```

All active development should happen here.

This includes:

- Writing code
- Experimentation
- Refactoring
- Local testing
- Debugging
- Feature development

The working branch may contain frequent development commits.

## 15. Create the Working Branch

Always start from the latest `main`.

```bash
git switch main
git pull origin main
```

Create the working branch:

```bash
git switch -c scraping/working/yash
```

Push the branch:

```bash
git push -u origin scraping/working/yash
```

## 16. Working Branch Development

Switch to the working branch:

```bash
git switch scraping/working/yash
```

Develop your feature.

Check your current state:

```bash
git status
```

Review your changes:

```bash
git diff
```

Commit meaningful changes:

```bash
git add .
git commit -m "feat(scraping): add worker pool"
```

Push your work:

```bash
git push
```

## 17. Stage Branch

The stage branch is used after the feature is considered ready for testing and review.

Example:

```text
scraping/stage/yash
```

The stage branch is used for:

- Integration testing
- Final testing
- QA
- Review preparation
- Demonstration
- Preparing the final PR

The stage branch should contain code that is ready to be reviewed.

## 18. Create the Stage Branch

Start from the latest `main`:

```bash
git switch main
git pull origin main
```

Create the stage branch:

```bash
git switch -c scraping/stage/yash
```

Then merge the working branch:

```bash
git merge scraping/working/yash
```

Push the stage branch:

```bash
git push -u origin scraping/stage/yash
```

## 19. Complete Feature Workflow

The complete workflow is:

```text
                         main
                           │
                           ▼
                Working Branch
                           │
                           │
                      Development
                           │
                           ▼
                         Testing
                           │
                           ▼
                  Stage Branch
                           │
                           │
                    Integration / QA
                           │
                           ▼
                          PR
                           │
                           ▼
                     Code Review
                           │
                           ▼
                       Siddhant
                           │
                 ┌─────────┴─────────┐
                 │                   │
              Changes              Approve
                 │                   │
                 ▼                   ▼
              Developer             main
```

Short version:

```text
Working → Stage → PR → Review → main
```

## 20. Development Workflow

While developing:

```bash
git switch scraping/working/yash
```

Write your code.

Check status:

```bash
git status
```

Review changes:

```bash
git diff
```

Run relevant tests.

Commit your work:

```bash
git add .
git commit -m "feat(scraping): add worker pool"
```

Push:

```bash
git push
```

## 21. Testing Before Stage

Before moving a feature from **Working → Stage**, run the required project checks.

From the repository root:

```bash
pnpm install
```

Run lint:

```bash
pnpm lint
```

Run type checking:

```bash
pnpm typecheck
```

Run formatting check:

```bash
pnpm format:check
```

Run build:

```bash
pnpm build
```

Run tests:

```bash
pnpm test
```

If the domain has additional tests, run those tests as well.

All relevant checks should pass before moving code to the stage branch.

Do not move known broken or incomplete code to the stage branch.

## 22. Working → Stage

Once the feature is complete and tested:

Switch to the stage branch:

```bash
git switch scraping/stage/yash
```

Update from `main` if required:

```bash
git pull origin main
```

Merge the working branch:

```bash
git merge scraping/working/yash
```

Run the checks again:

```bash
pnpm lint
pnpm typecheck
pnpm format:check
pnpm build
pnpm test
```

Push the stage branch:

```bash
git push origin scraping/stage/yash
```

## 23. Why We Test Again on Stage

The working branch represents active development.

The stage branch represents code that is ready for integration and review.

Therefore, checks should be performed again after the working branch is merged into stage.

The stage branch should be considered the candidate branch for the final PR.

## 24. Pull Request Source Branch

Pull Requests should be created from the stage branch.

Example:

```text
scraping/stage/yash
                │
                ▼
               PR
                │
                ▼
              main
```

Do not create the final PR directly from the working branch.

## 25. Pull Request Description

Every PR should clearly explain:

- **What** — What was implemented?
- **Why** — Why was the change required?
- **Implementation** — What important implementation decisions were made?
- **Testing** — What tests were performed?
- **Known Limitations** — Are there any known limitations or follow-up tasks?

Example:

```md
## What

Added a worker pool for parallel scraping.

## Why

The previous implementation processed requests sequentially.

## Implementation

Added configurable worker concurrency and task handling.

## Testing

- pnpm lint
- pnpm typecheck
- pnpm build
- pnpm test

## Known Limitations

Concurrency tuning will be improved in a future change.
```

## 26. Final Merge Authority

Only the repository maintainer makes the final merge decision.

The process is:

```text
Developer
    ↓
Working Branch
    ↓
Stage Branch
    ↓
Pull Request
    ↓
Siddhant Review
    ↓
┌───────────────────────┐
│                       │
▼                       ▼
Approve              Request Changes
│                       │
▼                       ▼
Merge                 Developer
│                       │
▼                       │
main ◄─────────────────┘
```

A PR can be:

- Approved
- Rejected
- Returned for changes

Developers must not merge their own PRs.

## 27. Code Review Responsibilities

The reviewer should evaluate:

### Code Quality

- Is the implementation understandable?
- Is the code maintainable?
- Is unnecessary duplication avoided?
- Is the implementation unnecessarily complex?
- Are naming conventions clear?

### Architecture

- Is the correct domain being used?
- Are domain boundaries respected?
- Is shared functionality placed correctly?
- Are unnecessary dependencies introduced?
- Does the change affect other domains?

### Testing

- Are important cases tested?
- Are edge cases handled?
- Do existing tests still pass?
- Does the implementation behave as expected?

### Security

- Are inputs validated?
- Are credentials protected?
- Are secrets excluded?
- Are authentication checks correct?
- Are security-sensitive changes handled carefully?

### Performance

Where applicable:

- Is the implementation efficient?
- Is unnecessary network work avoided?
- Is unnecessary database work avoided?
- Are concurrency and resource usage reasonable?

## 28. Commit Guidelines

Use meaningful commit messages.

Preferred format:

```text
type(scope): description
```

Examples:

```text
feat(scraping): add worker pool
feat(searching): add ranking logic
feat(realtime): add websocket trigger
feat(security): add bot detection

fix(scraping): handle request timeout
fix(searching): handle empty query
fix(realtime): handle disconnected clients

refactor(searching): simplify ranking logic

test(scraping): add crawler tests

perf(scraping): improve crawler throughput

docs(scraping): update crawler documentation

chore: update dependencies
```

## 29. Avoid Bad Commit Messages

Avoid meaningless commits such as:

```text
update
changes
final
final2
done
working
testing
new
asdf
abc
```

Commit messages should explain what changed.

## 30. Staging Changes

Before staging changes:

```bash
git status
```

Review the changes:

```bash
git diff
```

Stage the required changes:

```bash
git add .
```

Check staged changes:

```bash
git status
```

Commit:

```bash
git commit -m "feat(scraping): add worker pool"
```

## 31. Push Working Branch

Example:

```bash
git push -u origin scraping/working/yash
```

After the first push:

```bash
git push
```

## 32. Push Stage Branch

Example:

```bash
git push -u origin scraping/stage/yash
```

After the first push:

```bash
git push
```

## 33. Pull Latest Main

When you need the latest changes from `main`:

```bash
git switch main
git pull origin main
```

Then return to your branch:

```bash
git switch scraping/working/yash
```

Update your branch according to the current team workflow.

Do not blindly overwrite another developer's work.

## 34. Never Push Directly to Main

Never do this:

```bash
git switch main
git add .
git commit -m "changes"
git push origin main
```

All feature work must follow:

```text
Working
   ↓
Stage
   ↓
Pull Request
   ↓
Code Review
   ↓
main
```

## 35. Pull Request Checklist

Before creating a PR:

- [ ] Correct domain is used
- [ ] Correct branch naming is used
- [ ] Working branch has been tested
- [ ] Stage branch has been tested
- [ ] `pnpm lint` passes
- [ ] `pnpm typecheck` passes
- [ ] `pnpm format:check` passes
- [ ] `pnpm build` passes
- [ ] `pnpm test` passes
- [ ] Domain-specific tests pass
- [ ] No secrets are committed
- [ ] No `.env` files are committed
- [ ] No unnecessary debugging code remains
- [ ] No unnecessary files are included
- [ ] Commit messages are meaningful
- [ ] PR description is complete
- [ ] Known limitations are documented

## 36. Environment Variables

Never commit sensitive information.

Never commit:

- `.env`
- API keys
- Passwords
- JWT secrets
- Database credentials
- AWS credentials
- Private keys
- Access tokens
- Cloud credentials

Use:

```text
.env.example
```

Example:

```env
PORT=
DATABASE_URL=
JWT_SECRET=
S3_BUCKET=
```

Never put real credentials inside `.env.example`.

## 37. Shared Package Usage

Before creating a utility inside a domain, check whether the functionality already exists in:

```text
packages/
```

Current shared packages:

- `@tavily/config`
- `@tavily/errors`
- `@tavily/logger`

For example, use the shared logger instead of creating a separate logger implementation inside a domain.

```ts
import { logger } from "@tavily/logger";

logger.info("Server started", {
  port: 3000,
});
```

Use the shared `AppError` instead of creating duplicate application error implementations.

## 38. Adding New Shared Packages

Do not create a new package inside:

```text
packages/
```

without discussing it first.

A shared package should only be created when the functionality:

- Is genuinely reusable
- Is needed by multiple domains/apps
- Has a clear responsibility
- Should not belong to a single domain

Avoid creating packages for domain-specific logic.

## 39. Adding a New Domain

Creating a new domain is an architectural change.

Before creating one, discuss:

- Why the domain is required
- What responsibility it owns
- Why existing domains are insufficient
- What dependencies it will have
- How it will interact with other domains

Do not create new top-level domains casually.

## 40. Infrastructure Changes

Infrastructure changes should be treated carefully.

Before introducing a new external system or infrastructure dependency, consider:

- Why it is required
- Which domain needs it
- Whether it belongs in `infrastructure/`
- Whether an existing package/system can be reused
- Security implications
- Performance implications
- Operational complexity

## 41. Dependency Rules

Avoid unnecessary dependencies.

Before adding a dependency:

- Check whether the functionality already exists.
- Check whether an existing project dependency can be reused.
- Verify that the dependency is actually required.
- Consider security and maintenance implications.

Do not add dependencies simply for convenience when a small internal implementation is sufficient.

## 42. Documentation

Update documentation when you change:

- Public behavior
- Domain architecture
- Developer workflow
- Configuration
- APIs
- Important implementation decisions

Domain-specific documentation belongs in:

```text
domains/<domain>/docs/
```

Repository-wide contribution rules belong in:

```text
CONTRIBUTING.md
```

## 43. Code Cleanliness

Before creating a PR, remove:

- `console.log()`
- temporary debugging code
- unused imports
- unused variables
- commented-out dead code
- temporary files
- local configuration
- secrets

Keep the final PR clean.

## 44. Generated Files

Do not commit generated output unless the project explicitly requires it.

Examples of files that normally should not be committed:

```text
dist/
build/
coverage/
.turbo/
node_modules/
```

Follow the repository `.gitignore`.

## 45. Local Development

After cloning the repository:

```bash
git clone <repository-url>
cd tavily
```

Install dependencies:

```bash
pnpm install
```

Before starting development, make sure you are working from the latest `main`:

```bash
git switch main
git pull origin main
```

Then create your working branch.

## 46. Standard Repository Checks

From the repository root:

### Lint

```bash
pnpm lint
```

### Typecheck

```bash
pnpm typecheck
```

### Formatting

```bash
pnpm format:check
```

### Build

```bash
pnpm build
```

### Tests

```bash
pnpm test
```

Run all relevant checks before creating the PR.

## 47. Development Philosophy

The project follows these principles:

```text
Clear ownership
      ↓
Clear domain boundaries
      ↓
Small focused changes
      ↓
Tested implementation
      ↓
Stage validation
      ↓
Code review
      ↓
Controlled merge
```

The objective is not only to make the code work.

The objective is to keep the codebase:

- Maintainable
- Testable
- Understandable
- Scalable
- Secure
- Production-ready

## 48. Final Contributor Workflow

For every feature:

```text
                         main
                           │
                           ▼
             ┌────────────────────────┐
             │     Working Branch     │
             │                        │
             │ feature/<feature>/     │
             │ working/<name>         │
             └───────────┬────────────┘
                         │
                         │
                    Development
                         │
                         ▼
                       Testing
                         │
                         ▼
             ┌────────────────────────┐
             │      Stage Branch     │
             │                        │
             │ feature/<feature>/     │
             │ stage/<name>           │
             └───────────┬────────────┘
                         │
                         │
                  Integration / QA
                         │
                         ▼
                   Pull Request
                         │
                         ▼
                    Siddhant Review
                         │
                  ┌──────┴──────┐
                  │             │
               Changes        Approve
                  │             │
                  ▼             ▼
              Developer        main
                  │
                  └──────────────►
```

## 49. Golden Rules

1. **Work in the Correct Domain**

```text
scraping  → domains/scraping/
searching → domains/searching/
realtime  → domains/realtime/
security  → domains/security/
```

2. **Two Branches Per Development Task**

```text
<domain>/working/<name>
<domain>/stage/<name>
```

3. **Never Push Directly to Main**

```text
Working → Stage → PR → Review → main
```

4. **Test Before Stage**

Run:

```bash
pnpm lint
pnpm typecheck
pnpm format:check
pnpm build
pnpm test
```

5. **Stage Must Be Review-Ready**

The stage branch is the candidate for the final PR.

6. **Do Not Merge Your Own PR**

The final merge decision belongs to the repository maintainer.

7. **Keep Domains Independent**

Do not introduce unnecessary cross-domain dependencies.

8. **Reuse Shared Packages**

Use:

- `@tavily/config`
- `@tavily/errors`
- `@tavily/logger`

when applicable.

9. **Never Commit Secrets**

Keep credentials outside Git.

10. **Keep Commits Meaningful**

Use Conventional Commit messages.

11. **Keep PRs Focused**

One PR should represent one logical change or feature.

12. **Discuss Architectural Changes**

Do not change the repository architecture without discussing it first.

## 50. Remember

```text
Assigned Domain
       ↓
Working Branch
       ↓
Development
       ↓
Testing
       ↓
Stage Branch
       ↓
Integration / QA
       ↓
Pull Request
       ↓
Code Review
       ↓
Siddhant
       ↓
Approve / Request Changes / Reject
       ↓
Merge
       ↓
main
```

Build clean.

Test everything.

Review carefully.

Keep domain boundaries clear.

Contribute responsibly. 🚀
