# syntax=docker/dockerfile:1

# ---- Stage 1: production dependencies ------------------------------------
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---- Stage 2: runtime -----------------------------------------------------
FROM node:24-alpine AS runtime
ENV NODE_ENV=production \
    PORT=5000 \
    HOST=0.0.0.0 \
    TWIN_DATA_DIR=/data
WORKDIR /app

# Persistent mission recordings live in /data (mount a volume there).
RUN mkdir -p /data && chown node:node /data

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json server.js config.js simulator.js ./
COPY --chown=node:node ai ./ai
COPY --chown=node:node analytics ./analytics
COPY --chown=node:node engine_sim ./engine_sim
COPY --chown=node:node middleware ./middleware
COPY --chown=node:node replay ./replay
COPY --chown=node:node twin_core ./twin_core
COPY --chown=node:node public ./public

USER node
VOLUME ["/data"]
EXPOSE 5000

# No curl in alpine-node: use Node's built-in fetch against the liveness probe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Run node directly (not start.js, which tries to open a browser / npm install).
# Signals: run the container with an init process so SIGTERM reaches node and
# zombies are reaped: `docker run --init ...` (docker-compose.yml sets init: true).
CMD ["node", "server.js"]
