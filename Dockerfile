FROM node:24-bookworm AS verify
RUN apt-get update && apt-get install -y --no-install-recommends postgresql curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY deploy ./deploy
COPY assets ./assets
# Package the pinned OCR language file; runtime never downloads language data.
RUN curl --fail --location --retry 3 https://tessdata.projectnaptha.com/4.0.0/eng.traineddata.gz --output assets/eng.traineddata.gz && echo "ed350f3752f81ee8f38769edc14d92d997dababe23b565c59879372cc46a2468  assets/eng.traineddata.gz" | sha256sum --check -
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
COPY --from=verify --chown=node:node /app/assets ./assets
COPY --from=verify --chown=node:node /app/migrations ./migrations
USER node
RUN mkdir -p /home/node/.ssh && chmod 0700 /home/node/.ssh
CMD ["node", "src/worker.ts"]
