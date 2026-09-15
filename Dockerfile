FROM node:24-bookworm AS verify
RUN apt-get update && apt-get install -y --no-install-recommends postgresql && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations
COPY tests ./tests
# Disposable database exists only in the build stage. No production secret is
# passed here. Debian Bookworm's PostgreSQL 15 verifies the portable SQL subset.
RUN pg_ctlcluster 15 main start && runuser -u postgres -- psql -c 'CREATE ROLE root WITH LOGIN SUPERUSER' && MLG_TEST_DATABASE_URL='postgresql://root@localhost/postgres?host=/var/run/postgresql' npm test && npm run typecheck && pg_ctlcluster 15 main stop

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=verify --chown=node:node /app/src ./src
COPY --from=verify --chown=node:node /app/scripts ./scripts
COPY --from=verify --chown=node:node /app/migrations ./migrations
USER node
RUN mkdir -p /home/node/.ssh && chmod 0700 /home/node/.ssh
CMD ["node", "src/worker.ts"]
