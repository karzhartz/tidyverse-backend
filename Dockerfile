# syntax=docker/dockerfile:1
# Wimak service — the HTTP API in front of Supabase and Stripe.
#
#   docker build -t wimak-service .
#   docker run --rm --env-file .env -p 8000:8000 wimak-service
#
# The secret keys are NOT baked in: they are read from the environment at
# runtime, so .env is excluded here (see .dockerignore) and passed with
# --env-file or an orchestrator's secret store.

# ── Dependencies ─────────────────────────────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app
# Copy only the manifests first, so this layer is cached until a dependency
# actually changes.
COPY package.json package-lock.json ./
# `npm ci` installs exactly the lockfile and fails if the two disagree.
RUN npm ci --omit=dev

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

# Bind to every interface. The service defaults to 127.0.0.1, which inside a
# container means nothing outside it can connect.
ENV HOST=0.0.0.0
ENV PORT=8000

EXPOSE 8000

# The image ships the node user; the service has no reason to run as root.
USER node

# Readiness without curl (not in the base image): /health is unauthenticated
# and answers whether the process is up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.mjs"]
