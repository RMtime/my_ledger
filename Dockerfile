FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM deps AS migrator
WORKDIR /app
COPY tsconfig.json ./tsconfig.json
COPY drizzle ./drizzle
COPY scripts/migrate.ts ./scripts/migrate.ts
COPY scripts/audit-data.ts ./scripts/audit-data.ts
COPY src ./src
RUN mkdir -p /app/data /app/backups && chown node:node /app/data /app/backups
USER node
CMD ["npm","run","db:migrate"]

FROM node:24-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0 DATABASE_PATH=/app/data/ledger.db
RUN mkdir -p /app/data && chown node:node /app/data
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/drizzle ./drizzle
COPY --from=builder --chown=node:node /app/scripts/backup.mjs ./scripts/backup.mjs
RUN mkdir -p /app/backups && chown node:node /app/backups
USER node
EXPOSE 3000
VOLUME ["/app/data", "/app/backups"]
CMD ["node","server.js"]
