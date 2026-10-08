# ==========================================
# Build Stage
# ==========================================
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Install pnpm matching repository packageManager configuration
RUN npm install -g pnpm@12.9.1

# Copy workspace configuration and dependency manifests
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.json turbo.json types.d.ts ./
COPY packages/config/package.json packages/config/tsconfig.json ./packages/config/
COPY packages/errors/package.json packages/errors/tsconfig.json ./packages/errors/
COPY packages/logger/package.json packages/logger/tsconfig.json ./packages/logger/
COPY domains/searching/package.json domains/searching/tsconfig.json ./domains/searching/

# Install dependencies reproducibly
RUN pnpm install --frozen-lockfile

# Copy source code
COPY packages/config/src ./packages/config/src
COPY packages/errors/src ./packages/errors/src
COPY packages/logger/src ./packages/logger/src
COPY domains/searching/src ./domains/searching/src
COPY domains/searching/test ./domains/searching/test

# Build searching service and all workspace package dependencies
RUN pnpm --filter @tavily/searching... build

# Prune devDependencies to keep only production dependencies
RUN pnpm prune --prod

# ==========================================
# Production Runtime Stage
# ==========================================
FROM node:22-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Copy root manifests and pruned production dependencies
COPY --from=builder --chown=node:node /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=builder --chown=node:node /app/node_modules ./node_modules

# Copy built workspace packages and searching domain
COPY --from=builder --chown=node:node /app/packages ./packages
COPY --from=builder --chown=node:node /app/domains/searching ./domains/searching

# Run as non-root user
USER node

EXPOSE 3000

WORKDIR /app/domains/searching

# Execute the existing production start command: node dist/src/server.js
CMD ["node", "dist/src/server.js"]
