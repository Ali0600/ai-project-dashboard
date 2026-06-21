# syntax=docker/dockerfile:1

# ---- deps: install node modules (with build tools for the native sqlite module) ----
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

# ---- builder: produce the standalone Next.js server ----
FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---- runner: slim runtime image ----
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV DASHBOARD_DB=/app/data/dashboard.db

# Next.js standalone output bundles only the files the server needs.
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Persist the SQLite DB on a mounted volume.
VOLUME ["/app/data"]
EXPOSE 3000
CMD ["node", "server.js"]

# NOTE: automatic capture (hooks) and headless scanning (claude -p) require the host's
# `claude` CLI and ~/.claude data, which are not present in this container. The image
# serves the dashboard UI and manual board use; run `npm run backfill` / hooks on the host.
