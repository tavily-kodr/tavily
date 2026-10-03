# Project Development Guide

Welcome to the project.

This guide defines the rules that every contributor must follow while developing and contributing code.

The guidelines are divided into **three parts**:

1. **Technology & Package Manager**
2. **Project Folder Structure**
3. **Contribution & Git Workflow**

---

# Part 1 — TypeScript & pnpm

## 1. TypeScript Only

All application code must be written in **TypeScript**.

### Allowed

```text
.ts
.tsx
```

Examples:

```text
src/index.ts
src/app.ts
src/controllers/user.controller.ts
src/components/Login.tsx
```

### Not Allowed

```text
.js
.jsx
```

Do not add JavaScript files unless explicitly approved by the project maintainers.

---

## 2. pnpm Only

This project uses **pnpm** as the package manager.

Every contributor must use pnpm.

### Install dependencies

```bash
pnpm install
```

### Add a dependency

```bash
pnpm add package-name
```

### Add a development dependency

```bash
pnpm add -D package-name
```

### Run the project

```bash
pnpm dev
```

### Build

```bash
pnpm build
```

### Run tests

```bash
pnpm test
```

### Type checking

```bash
pnpm exec tsc --noEmit
```

---

## 3. Do Not Use Other Package Managers

❌ Do not use:

```bash
npm install
npm run dev
npm test
```

```bash
yarn install
yarn add
```

```bash
bun install
bun add
```

✅ Use:

```bash
pnpm install
pnpm dev
pnpm test
```

---

## 4. Lockfile

The project uses:

```text
pnpm-lock.yaml
```

Do not commit:

```text
package-lock.json
yarn.lock
bun.lock
```

If one is accidentally generated, remove it before committing.

---

