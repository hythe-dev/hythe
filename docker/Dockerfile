# Engram server — multi-stage build
FROM node:22-bookworm AS builder
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src/ ./src/
COPY mcp-stdio-http-bridge.cjs ./
RUN npm run build

FROM node:22-bookworm AS app-runtime-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm ls --omit=dev \
    && npm audit --omit=dev --audit-level=high

FROM node:22-bookworm AS transformer-runtime-dependencies
WORKDIR /opt/hythe-transformers
COPY docker/transformers-runtime/package.json docker/transformers-runtime/package-lock.json ./
RUN npm ci --omit=dev \
    && npm ls --omit=dev \
    && npm audit --omit=dev --audit-level=high

FROM node:22-bookworm-slim
RUN groupadd -g 1001 engram && useradd -m -s /bin/bash -u 1001 -g engram engram
WORKDIR /app
COPY --from=builder --chown=engram:engram /app/dist ./dist
COPY --from=app-runtime-dependencies --chown=engram:engram /app/node_modules ./node_modules
COPY --from=app-runtime-dependencies --chown=engram:engram /app/package.json /app/package-lock.json ./
COPY --from=transformer-runtime-dependencies /opt/hythe-transformers /opt/hythe-transformers
COPY --from=builder --chown=engram:engram /app/mcp-stdio-http-bridge.cjs ./
COPY --chown=engram:engram docker/verify-transformer-runtime.mjs ./docker/verify-transformer-runtime.mjs
RUN mkdir -p /app/data/models && chown -R engram:engram /app
ENV SQLITE_VEC_TRANSFORMERS_MODULE=file:///opt/hythe-transformers/node_modules/@xenova/transformers/src/transformers.js \
    SQLITE_VEC_REQUIRE_TRANSFORMERS=true \
    SQLITE_VEC_CACHE_DIR=/app/data/models \
    SQLITE_VEC_DIMENSIONS=384 \
    SQLITE_VEC_MODEL=Xenova/all-MiniLM-L6-v2
USER engram
EXPOSE 6174 3004
HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=40s \
  CMD node -e "fetch('http://localhost:6174/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["sh", "-c", "node docker/verify-transformer-runtime.mjs && exec node dist/unified-neural-mcp-server.js"]
