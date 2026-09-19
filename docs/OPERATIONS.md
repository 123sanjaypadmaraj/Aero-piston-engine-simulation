# Operations runbook

For deployment see `docs/DEPLOYMENT.md`. All data is simulated; "operational"
here means keeping the demo/staging service healthy.

## Health endpoints

| Endpoint | Use | Healthy response | Unhealthy |
|---|---|---|---|
| `GET /api/health` | **Liveness** - is the process up and serving? Restart the container if this fails repeatedly. | `200 { "ok": true, "service": "aero-engine-digital-twin", "uptime": <s> }` | no response |
| `GET /api/ready` | **Readiness** - can it do useful work? Route traffic only when this is 200. | `200 { "ready": true, "checks": { "fleet": true, "store": true } }` | `503` with the failing check set to `false` |

`/api/ready` fails when the fleet simulator has not produced a snapshot yet
(`fleet: false`, only during startup), when the data directory is not writable
(`store: false`), or while the server is shutting down. Both probes bypass
rate limiting. Docker's `HEALTHCHECK` and the compose healthcheck use
`/api/health`.

```bash
curl -fsS localhost:5000/api/health
curl -sS  localhost:5000/api/ready
docker inspect --format '{{.State.Health.Status}}' <container>
```

Note that `/api/health` does **not** verify AI availability: the app is
healthy-but-degraded when no AI provider works. Check the `aiAnalysis` objects
(`degraded`, `provider`, `cooldownUntil`) in `/api/ai-analysis` for that.

## Logs

- Structured logs go to stdout (info/debug) and stderr (warn/error). In
  production (`NODE_ENV=production`) each line is JSON:
  `{"level":"warn","time":"...","msg":"...", ...fields}`; in development they are
  human-readable.
- `LOG_LEVEL` = `silent | error | warn | info | debug` (default `info`). Use
  `debug` briefly when investigating; it is noisy.
- Every HTTP request is logged with a request id (`reqId`), method, URL,
  status, duration and client IP. The id is echoed in the `X-Request-Id` response header so a failing
  request can be correlated with its log line.
- Provider cooldown start/end is logged **once per transition**, not per call,
  so a quota problem shows as a couple of lines, not a flood.
- API keys are never logged; the startup `configuration` line only says whether
  each key is `set` or not.

```bash
docker compose logs -f twin
docker compose logs twin | grep '"level":"error"'
docker compose logs twin | grep -i cooldown
```

Ship stdout to your collector (Docker logging driver, journald, etc.);
the app does not write log files or rotate them.

## Common failure modes

### AI provider quota exhausted (429)

Free-tier keys have small per-minute and per-day quotas. When Gemini returns
429 the provider enters a cooldown (`AI_PROVIDER_COOLDOWN_MS`, 5 min by
default, or the server-supplied retry hint), and requests go to Groq if a
`GROQ_API_KEY` is configured. Expected symptoms: a `cooldown` log line, `aiAnalysis.provider`
= `groq` with `fallbackUsed: true`, and the dashboard labelling the report as
coming from the fallback provider. When the cooldown ends Gemini is tried again.
If both providers are exhausted or unconfigured, `degraded: true` and the
dashboard shows the rule-based summary; degraded engines are retried
automatically once the blocking cooldown ends.
Mitigations: add the other provider's key, raise `AI_ANALYSIS_INTERVAL_MS`,
choose a higher-quota model (`GEMINI_MODEL`), or raise `GEMINI_MIN_GAP_MS`.

### Stale telemetry

Telemetry ticks every `TICK_MS` (2 s). The dashboard shows a **stale
telemetry** banner when snapshots stop arriving (socket disconnected, server
stalled, proxy dropping websockets) and offers a retry; the readings on
screen may then be out of date and must not be treated as current. If it is
persistent: check `/api/health`, then proxy websocket config
(`docs/DEPLOYMENT.md`), then server logs for `telemetry tick failed`.

### Disk usage / retention

Recordings live in `TWIN_DATA_DIR`. Only the newest `TWIN_MAX_MISSIONS_PER_ENGINE`
(default 50) per engine are kept. A one-hour mission is a few MB of JSON-Lines,
so worst case is roughly engines x 50 x mission size. If the volume is full,
`/api/ready` reports `store: false` and new mission runs fail; free space or
lower the retention limit and restart.

### Too many requests (429 from the API)

`RATE_LIMIT_MAX` / `RATE_LIMIT_HEAVY_MAX` per IP per window, or "too many
concurrent mission runs" (`MAX_CONCURRENT_MISSIONS`). Behind a proxy without
`TRUST_PROXY`, every user shares the proxy's IP and hits the limit together.

### Socket connections refused

`SOCKET_MAX_PER_IP` / `SOCKET_MAX_TOTAL` reached (log line "socket connection
refused (cap reached)"), or the browser origin is not in `CORS_ORIGIN`.

## Troubleshooting table

| Symptom | Likely cause | Check / fix |
|---|---|---|
| Container exits immediately, log says `Invalid configuration` | Bad env value (e.g. non-numeric `PORT`, `ADMIN_API_KEY` < 8 chars, malformed `CORS_ORIGIN`) | Read the listed problems; compare with `.env.example` |
| `port 5000 is already in use` | Another process on the port | Change `PORT` / `HOST_PORT` or stop the other process |
| `/api/ready` 503, `store: false` | Data dir missing or not writable (volume permissions, read-only FS without a `/data` mount, full disk) | Ensure `TWIN_DATA_DIR` is a writable mount owned by uid 1000 (`node`); check disk space |
| `/api/ready` 503, `fleet: false` | Still starting, or the simulator failed at startup | Wait a few seconds; check error logs |
| Dashboard live indicator disconnected / stale banner | Websocket blocked by proxy, server down, network | `curl /api/health`; verify `Upgrade`/`Connection` headers in the proxy; browser console |
| Works locally, but the UI font differs on a locked-down network | The Inter web font is fetched from Google Fonts | Allow fonts.googleapis.com / fonts.gstatic.com or self-host the font (and adjust the CSP); the page falls back to system fonts |
| Browser CORS error / `403` on socket upgrade | Origin not allowed | Add the exact origin (scheme+host+port) to `CORS_ORIGIN` |
| `401 unauthorized` on POST routes / **Explain now** | `ADMIN_API_KEY` set and no `x-api-key` sent | Send the header (curl, proxy injection); the bundled dashboard does not |
| `429` on API calls | Rate limit or concurrent-mission cap | Back off; tune `RATE_LIMIT_*`; set `TRUST_PROXY` behind a proxy |
| AI panel always shows rule-based text | No key, both providers cooling down, or invalid key | Check startup `configuration` log (`gemini`/`groq` key set?), `aiAnalysis.error` and `cooldownUntil` in `/api/ai-analysis`; invalid keys cool down for 1 h - fix the key and restart |
| AI text labelled as fallback provider | Primary provider failed or is cooling down | Expected during Gemini quota exhaustion; see above |
| Mission recordings vanish after container recreate | No persistent volume on `/data` | Use the named volume in `docker-compose.yml` |
| Two dashboards show different data | More than one instance behind a load balancer | Run a single instance (`docs/DEPLOYMENT.md`, "Scaling") |
| Graceful stop takes ~10 s then exits non-zero | Connections did not drain within `SHUTDOWN_TIMEOUT_MS` | Raise it (and the orchestrator grace period), or investigate long-lived requests |

## Routine checks

- `docker compose ps` shows `(healthy)`.
- `/api/ready` returns 200.
- No sustained `level":"error"` lines; cooldown lines are occasional.
- Volume usage is stable (retention working).
- `npm audit --omit=dev` is clean or triaged (CI runs it, non-blocking).
