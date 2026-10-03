
# Contribution Guidelines

## 1. Every Contributor Gets Two Branches Per Feature

For **each feature**, every contributor must have two branches:

```text
1. Working branch
2. Stage branch
```

The branch naming convention is:

```text
feature/<feature-name>/working/<contributor-name>
feature/<feature-name>/stage/<contributor-name>
```

### Example

If Yash is working on authentication:

```text
feature/auth/working/yash
feature/auth/stage/yash
```

If Rahul is working on video upload:

```text
feature/video-upload/working/rahul
feature/video-upload/stage/rahul
```

---

# 2. Working Branch

The **working branch** is where active development happens.

Example:

```text
feature/auth/working/yash
```

All coding, experimentation, and local development should happen here.

Create it from the latest `main`:

```bash
git checkout main
git pull origin main

git checkout -b feature/auth/working/yash
```

---

# 3. Stage Branch

The **stage branch** is used to prepare the completed feature for testing and review.

Example:

```text
feature/auth/stage/yash
```

The working branch should be merged into the stage branch when the contributor considers the feature ready for testing.

```text
feature/auth/working/yash
              │
              │
              ▼
feature/auth/stage/yash
```

The stage branch can then be used for:

* Integration testing
* Final testing
* Review preparation
* QA
* Demonstration

---

# 4. Feature Workflow

The complete flow is:

```text
                    main
                     │
                     │
                     ▼
        feature/auth/working/yash
                     │
                     │ development
                     │
                     ▼
        feature/auth/working/yash
                     │
                     │ feature completed
                     ▼
         feature/auth/stage/yash
                     │
                     │ testing
                     │ review
                     ▼
                    PR
                     │
                     ▼
                   main
```

---

# 5. Creating Both Branches

Start from the latest `main`:

```bash
git checkout main
git pull origin main
```

Create the working branch:

```bash
git checkout -b feature/auth/working/yash
```

After the feature is ready, create the stage branch:

```bash
git checkout main
git pull origin main

git checkout -b feature/auth/stage/yash
```

Then merge the working branch:

```bash
git merge feature/auth/working/yash
```

---

# 6. Development Workflow

While developing:

```bash
git checkout feature/auth/working/yash
```

Write your code.

Run the development server:

```bash
pnpm dev
```

Check your changes:

```bash
git status
git diff
```

---

# 7. Test Before Moving to Stage

Before merging your working branch into stage, run:

```bash
pnpm install
pnpm build
pnpm exec tsc --noEmit
pnpm test
```

All checks should pass.

Do not move incomplete or broken code to the stage branch.

---

# 8. Move Working → Stage

After testing:

```bash
git checkout feature/auth/stage/yash
```

Update it if necessary:

```bash
git pull origin main
```

Merge your working branch:

```bash
git merge feature/auth/working/yash
```

Run the tests again:

```bash
pnpm build
pnpm exec tsc --noEmit
pnpm test
```

Then push:

```bash
git push origin feature/auth/stage/yash
```

---

# 9. Create Pull Request

When the stage branch is ready:

```text
feature/auth/stage/yash
             │
             ▼
            PR
             │
             ▼
           main
```

The Pull Request should contain:

* What was implemented
* Why it was implemented
* Files/components changed
* Tests performed
* Any known limitations

---

# 10. Commit Guidelines

Use meaningful commit messages.

### Good

```text
feat: add user authentication
feat: add video upload endpoint
fix: handle invalid login credentials
fix: resolve video upload validation
```

### Avoid

```text
update
changes
final
final2
test
working
asdf
done
```

---

# 11. Staging Changes

Before committing:

```bash
git status
```

Review:

```bash
git diff
```

Stage:

```bash
git add .
```

Check again:

```bash
git status
```

Commit:

```bash
git commit -m "feat: add authentication"
```

---

# 12. Push Changes

Working branch:

```bash
git push -u origin feature/auth/working/yash
```

Stage branch:

```bash
git push -u origin feature/auth/stage/yash
```

---

# 13. Pull Request Rules

Before creating a PR:

* [ ] Code is TypeScript.
* [ ] Only pnpm was used.
* [ ] Correct folder structure is followed.
* [ ] Branch follows the naming convention.
* [ ] Working branch has been tested.
* [ ] Stage branch has been tested.
* [ ] `pnpm build` passes.
* [ ] TypeScript check passes.
* [ ] Tests pass.
* [ ] No secrets are committed.
* [ ] No unnecessary debugging code remains.
* [ ] Commit messages are meaningful.
* [ ] PR description is complete.

---

# 14. Do Not Push Directly to Main

# Never:

```bash
git checkout main
git add .
git commit
git push origin main
```

All changes must follow:

```text
Working Branch
      ↓
Stage Branch
      ↓
Pull Request
      ↓
Code Review
      ↓
main
```

---

# 15. Code Review

Before merging, reviewers should check:

### Code

* Is the implementation understandable?
* Does it follow the project structure?
* Is unnecessary duplication avoided?

### TypeScript

* Are types properly defined?
* Is unnecessary `any` being used?
* Does TypeScript compile successfully?

### Testing

* Are important cases tested?
* Do existing tests still pass?
* Are edge cases handled?

### Security

* Are inputs validated?
* Are credentials protected?
* Are secrets excluded?
* Are authentication/authorization checks correct?

---

# 16. Environment Variables

Never commit:

```text
.env
API keys
Passwords
JWT secrets
Database credentials
AWS credentials
Private keys
Access tokens
```

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

---

# 17. Final Contributor Workflow

For every feature:

```text
                    main
                     │
                     ▼
        ┌─────────────────────────┐
        │ Working Branch          │
        │                         │
        │ feature/auth/           │
        │ working/yash            │
        └────────────┬────────────┘
                     │
                 Development
                     │
                     ▼
                  Testing
                     │
                     ▼
        ┌─────────────────────────┐
        │ Stage Branch            │
        │                         │
        │ feature/auth/           │
        │ stage/yash              │
        └────────────┬────────────┘
                     │
              Integration / QA
                     │
                     ▼
              Pull Request
                     │
                     ▼
                Code Review
                     │
                     ▼
                   main
```

---

# Golden Rules

### 1. TypeScript Only

```text
.ts / .tsx
```

### 2. pnpm Only

```text
pnpm
```

### 3. Follow the Folder Structure

Put code in the correct layer.

### 4. Two Branches Per Feature

```text
feature/<feature>/working/<name>
feature/<feature>/stage/<name>
```

### 5. Test Before Stage

```bash
pnpm build
pnpm exec tsc --noEmit
pnpm test
```

### 6. Never Push Directly to Main

```text
working → stage → PR → main
```

### 7. Review Your Changes

```bash
git status
git diff
```

### 8. Never Commit Secrets

Keep credentials and `.env` files out of Git.

### 9. Keep Commits Meaningful

Write commits that explain what changed.

### 10. Keep the Codebase Clean

Write readable, maintainable, tested code.

---

# Remember

```text
TypeScript
    ↓
pnpm
    ↓
Follow Folder Structure
    ↓
Working Branch
    ↓
Develop
    ↓
Test
    ↓
Stage Branch
    ↓
Integration / QA
    ↓
Pull Request
    ↓
Code Review
    ↓
main
```

**Build clean.
Test everything.
Review carefully.
Contribute responsibly. 🚀**
