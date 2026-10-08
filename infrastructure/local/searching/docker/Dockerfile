FROM node:22-bookworm-slim

WORKDIR /app

# Install pnpm matching repository packageManager configuration
RUN npm install -g pnpm@12.9.1

# Copy root configuration and dependency manifests for optimal layer caching
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.json turbo.json types.d.ts ./
COPY packages/config/package.json packages/config/tsconfig.json ./packages/config/
COPY packages/errors/package.json packages/errors/tsconfig.json ./packages/errors/
COPY packages/logger/package.json packages/logger/tsconfig.json ./packages/logger/
COPY domains/searching/package.json domains/searching/tsconfig.json ./domains/searching/

# Install all dependencies (including devDependencies like tsx and typescript)
RUN pnpm install --frozen-lockfile

# Copy source code of packages and searching domain
COPY packages/config/src ./packages/config/src
COPY packages/errors/src ./packages/errors/src
COPY packages/logger/src ./packages/logger/src
COPY domains/searching/src ./domains/searching/src
COPY domains/searching/test ./domains/searching/test

# Build dependent workspace packages so compiled output is available
RUN pnpm --filter @tavily/searching... build

ENV NODE_ENV=development
ENV PORT=3000

EXPOSE 3000

WORKDIR /app/domains/searching

CMD ["pnpm", "dev"]
