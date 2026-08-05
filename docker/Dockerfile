# Engram server — multi-stage build
FROM node:22-bookworm AS builder
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src/ ./src/
COPY mcp-stdio-http-bridge.cjs ./
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
RUN groupadd -g 1001 engram && useradd -m -s /bin/bash -u 1001 -g engram engram
WORKDIR /app
COPY --from=builder --chown=engram:engram /app/dist ./dist
COPY --from=builder --chown=engram:engram /app/node_modules ./node_modules
COPY --from=builder --chown=engram:engram /app/package.json ./
COPY --from=builder --chown=engram:engram /app/mcp-stdio-http-bridge.cjs ./
USER engram
EXPOSE 6174 3004
HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=40s \
  CMD node -e "fetch('http://localhost:6174/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/unified-neural-mcp-server.js"]
