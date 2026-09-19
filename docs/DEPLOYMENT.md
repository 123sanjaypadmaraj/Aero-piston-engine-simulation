# Deployment guide

This project is a prototype driven by **simulated** telemetry. The guidance
below is about running it reliably and safely as a demo/staging service - it
does not make the analytics suitable for operational or safety-of-flight use
(see `docs/MODEL_CARDS.md` and `docs/ROADMAP.md`).

## 1. Docker (recommended)

```bash
cp .env.example .env            # edit: keys, ADMIN_API_KEY, CORS_ORIGIN, ...
docker compose up -d --build
docker compose ps               # wait for (healthy)
```

What the image/compose file do:

| Aspect | Setting |
|---|---|
| Base | `node:24-alpine`, multi-stage (`npm ci --omit=dev` in a separate stage) |
| User | non-root `node` |
| Env | `NODE_ENV=production`, `HOST=0.0.0.0`, `PORT=5000`, `TWIN_DATA_DIR=/data` |
| Entrypoint | `node server.js` (not `start.js`, which tries to open a browser) |
| Signals | `init: true` in compose (`--init` for `docker run`) so SIGTERM reaches node; the app drains connections for up to `SHUTDOWN_TIMEOUT_MS` (default 10 s). Compose `stop_grace_period` is 15 s - keep it above `SHUTDOWN_TIMEOUT_MS`. |
| Health | `HEALTHCHECK` calls `/api/health` with Node's `fetch` (no curl in the image) |
| Filesystem | root FS read-only, `/tmp` tmpfs, `/data` named volume `twin-data` |
| Hardening | `cap_drop: ALL`, `no-new-privileges` |
| Secrets | read from `.env` at runtime via `env_file`; never copied into the image (`.dockerignore` excludes `.env*` except `.env.example`) |

To change the published port: `HOST_PORT=8080 docker compose up -d`.

Without compose: `docker build -t aero-engine-digital-twin .` then
`docker run -d --init -p 5000:5000 --env-file .env -v twin-data:/data --read-only --tmpfs /tmp aero-engine-digital-twin`.

### Without Docker

```bash
npm ci --omit=dev
NODE_ENV=production node server.js      # under systemd / pm2 / your process manager
```

Send SIGTERM to stop (graceful drain). Run as an unprivileged user and point
`TWIN_DATA_DIR` at a directory that user can write.

## 2. Reverse proxy and HTTPS

The app speaks plain HTTP and expects TLS to be terminated in front of it.
Two things matter:

1. **WebSocket upgrade** must be forwarded for `/socket.io/` (otherwise
   Socket.IO silently falls back to long-polling).
2. Set **`TRUST_PROXY`** so rate limiting and connection caps see the real
   client IP rather than the proxy's. Use the number of proxy hops in front of
   the app (`TRUST_PROXY=1` for a single nginx/Caddy). Do **not** set it when the
   app is directly reachable from the internet - clients could spoof
   `X-Forwarded-For` and evade the limits.

Also bind the app to loopback (or a private network) when the proxy is on the
same host: `HOST=127.0.0.1`, and publish the container port only on
`127.0.0.1` (`"127.0.0.1:5000:5000"`).

### nginx

```nginx
map $http_upgrade $connection_upgrade { default upgrade; '' close; }

server {
  listen 443 ssl http2;
  server_name twin.example.com;
  ssl_certificate     /etc/letsencrypt/live/twin.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/twin.example.com/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:5000;
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade           $http_upgrade;
    proxy_set_header Connection        $connection_upgrade;
    proxy_read_timeout 300s;         # keep idle websockets open
  }
}
server { listen 80; server_name twin.example.com; return 301 https://$host$request_uri; }
```

### Caddy

```caddyfile
twin.example.com {
  reverse_proxy 127.0.0.1:5000
}
```

Caddy obtains certificates automatically and forwards WebSocket upgrades and
`X-Forwarded-*` headers by default.

## 3. Access control

- **`ADMIN_API_KEY`** - when set (>= 8 chars; generate with
  `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`), every
  non-GET request under `/api` (mission runs, replay control, forced AI refresh)
  must carry `x-api-key: <key>`. GET routes, probes and the dashboard remain
  open, so this protects the expensive/mutating operations only - it is **not**
  login for the dashboard. If the dashboard must not be public, put
  authentication (basic auth, OAuth proxy, VPN) in the reverse proxy.
  Caveat: the bundled dashboard does not send the key, so its **Explain now**
  button returns `401` when the key is set. Either leave that button
  unused, or have the proxy inject the header for trusted users
  (`proxy_set_header x-api-key "...";` inside an authenticated location).
- **`CORS_ORIGIN`** - comma-separated browser origin allowlist, applied to both
  the REST API and Socket.IO (including the websocket upgrade). Unset in
  production means same-origin only, which is right when the dashboard is
  served by this app. Only add origins that host a separate front-end. Avoid `*`.
- **Rate limits** - `RATE_LIMIT_MAX` per IP per `RATE_LIMIT_WINDOW_MS` on `/api/*`,
  with a stricter `RATE_LIMIT_HEAVY_MAX` for mission runs, replays and AI
  refresh. `/api/health` and `/api/ready` are exempt so probes are never throttled.
- **Secrets** - keep `.env` out of git (already ignored), provision it with your
  platform's secret store where possible, and rotate a key immediately if it
  is ever committed or pasted somewhere public.
- The server sets security headers (helmet, including a CSP that allows only
  same-origin scripts, plus Google Fonts for styles/fonts). If you self-host
  the font, tighten the policy in `middleware/security.js`.

## 4. Persistent data

Mission recordings (`POST /api/engine-sim/run`) are written as JSON-Lines under
`TWIN_DATA_DIR` (`/data` in Docker, `./twin_core/data` otherwise), one
directory per engine. The newest `TWIN_MAX_MISSIONS_PER_ENGINE` (default 50)
recordings per engine are kept; older ones are pruned, and each recording is
capped at `TWIN_MAX_READINGS_PER_MISSION` (default 50000) readings, which bounds disk use.
The live 3-UAV telemetry itself is **not** persisted - it is regenerated in
memory, and alert history/time series reset on restart.

`GET /api/ready` returns 503 if the data directory is not writable.

### Backups

Recordings are plain files, so a file-level copy is enough. Mission files are
appended while a run is in progress; back up when no run is active, or accept
that an in-flight mission may be truncated.

```bash
# Snapshot the named volume to a tarball
docker run --rm -v aero-engine-digital-twin_twin-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/twin-data-$(date +%F).tgz -C /data .

# Restore into an empty volume
docker run --rm -v aero-engine-digital-twin_twin-data:/data -v "$PWD":/backup alpine \
  tar xzf /backup/twin-data-YYYY-MM-DD.tgz -C /data
```

(Compose prefixes the volume name with the project directory name; check with
`docker volume ls`.) Recordings come from simulated missions and can simply be
regenerated (runs are randomized, so not bit-identical), so back them up only if you
need the specific runs.

## 5. Scaling and availability

**Run exactly one instance.** Fleet state, alert history, the AI analysis cache,
provider cooldowns and replay sessions all live in the memory of one process,
and Socket.IO uses its default in-memory adapter. Two replicas behind a
load balancer would each simulate a *different* fleet, so dashboards would show
inconsistent data, and a websocket that lands on a different node than its
polling handshake would fail. Scaling out would require, at minimum:

- sticky sessions at the load balancer, **and**
- moving fleet state to a shared store (or making the simulator deterministic
  and single-writer) and adding the Socket.IO Redis adapter, **and**
- making the AI cache/cooldown state shared (or accepting per-node quotas).

None of that exists in this prototype. Vertical headroom is ample - the
workload is small - so prefer a single container with `restart: unless-stopped`
and monitoring on `/api/health` and `/api/ready`.

## 6. Upgrade procedure

```bash
git pull
docker compose up -d --build      # brief downtime while the container restarts
docker compose ps                 # confirm (healthy)
curl -fsS localhost:5000/api/ready
```

The container receives SIGTERM, stops the tick loop, ends replays, closes
sockets and exits within `SHUTDOWN_TIMEOUT_MS`. Connected dashboards
reconnect automatically and show a stale-telemetry banner in the meantime.
Roll back by checking out the previous revision and rebuilding.
