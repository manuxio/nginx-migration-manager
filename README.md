# nginx-migration-manager

A small, self-contained tool for **migrating a fleet of reverse-proxy hosts from one set of
backends to another** — built to cut ~250 domains from **backend A** to **backend B** during
an infrastructure migration, one host or one batch at a time, with instant rollback.

It runs as two Docker containers:

- **nginx** — hardened reverse proxy on 80/443 with a self-signed cert generated at first
  start. Secure by default; per-host configs are permissive (websockets, large bodies, long
  timeouts).
- **app** — a Node/Express + React admin UI (the *migration cockpit*) that turns a CSV into
  one nginx host file per domain, flips each host between backend A and B, and commits every
  change to git for a full audit trail and rollback.

Each host carries **two upstreams** — `address:port` (A, current) and `alt_address:alt_port`
(B, target) — and an active selector. Migrating a host = flipping it from A to B. Nothing is
ever mass-deleted; a CSV that omits a domain leaves it untouched.

---

## Quick start

```bash
cp .env.example .env          # set credentials (and ports if 80/443/3000 are taken)
docker compose up -d --build
```

- **Admin UI:** <http://localhost:3000> (basic auth — `admin` / `changeme` by default)
- **Proxy:** <http://localhost> and <https://localhost> (self-signed → the browser warning is expected)

Load `examples/test-10-hosts.csv` from the UI (Import → Preview → Apply) to try it.

## Configuration (`.env`)

| Variable | Default | Purpose |
|---|---|---|
| `HTTP_PORT` | `80` | host port → nginx :80 |
| `HTTPS_PORT` | `443` | host port → nginx :443 |
| `APP_PORT` | `3000` | host port → admin UI :3000 |
| `CERT_CN` | `localhost` | CN / primary SAN of the self-signed cert |
| `BASIC_AUTH_USER` | `admin` | admin UI user (empty = auth disabled) |
| `BASIC_AUTH_PASS` | `changeme` | admin UI password |

Container ports are fixed (nginx 80/443, app 3000); only the **host** mapping is configurable.

## CSV format

```csv
"domain-name","address","port","alt_address","alt_port"
"app.example.com","10.0.0.10","8080","10.0.1.10","8080"
"wiki.example.com","192.168.1.50",,,
```

- `address`/`alt_address` = IPv4 or hostname. `port`/`alt_port` optional, **default 80**.
- `alt_*` (backend B) is the migration target — leave blank for hosts with no B.
- Import is a **dry-run by default** (Preview); click Apply to commit.

## The migration cockpit

The host table is the workspace:

- **Summary bar** — on A / on B / disabled counts and a *% migrated* progress bar.
- **Filter** — search by host / backend A / backend B, plus status chips (on A, on B,
  disabled, no B). Bulk actions act on exactly the **filtered** set.
- **Cut over → B / Roll back → A** — bulk-switch every filtered host in one click; hosts with
  no B are skipped and reported.
- **→ A / → B** (per host) — flip one host's `proxy_pass`. The choice is **sticky**:
  re-importing the CSV refreshes addresses but never undoes a cutover.
- **Disable / Enable** — pause a host (`.conf` ↔ `.conf.disabled`) without deleting.
- **Peek / Edit** — view *and hand-edit* a host's live `.conf` in-app; Save commits a
  checkpoint and re-runs `nginx -t`, reporting pass/fail immediately.
- **Delete** — remove a single host (committed → recoverable via Rollback). No bulk delete.
- **Test config** — run `nginx -t` on demand (no reload) and show the result.
- **Download** one `.conf`, **Download all** as `.tar.gz`, or **Export CSV** (round-trips).

## How hand edits are respected

Each host is one file, `<domain>.conf`. Generated files tag the lines the importer owns:

```nginx
server_name app.example.com;        # managed:server_name
location / {
    # managed:primary 10.0.0.10:8080
    # managed:alt 10.0.1.10:8080
    # managed:active primary
    proxy_pass http://10.0.0.10:8080;   # managed:upstream
}
```

On import the app rewrites **only** the `# managed:*` lines and leaves everything else exactly
as you wrote it — add directives, tweak timeouts, they survive. A file with **no** markers is
treated as fully hand-authored and never touched. Delete a marker to pin that line by hand.

## Safety: validate, reload, audit, rollback

- A watcher inside the nginx container runs `nginx -t` before every reload. A broken file
  (or a bad hand edit) is **not** applied — the last-good config stays live and the error is
  surfaced in the UI, one click from the in-app editor.
- Every change (import, cutover, enable/disable, edit, delete) is committed to a git repo in
  the config volume. The **History** panel shows the last 50 commits with timestamps.
- **Rollback** restores the whole config to a chosen checkpoint and **discards everything
  after it** (`git reset --hard`; still recoverable via `git reflog` until gc).
- The app never touches the Docker socket — it signals the nginx container through the shared
  volume only.

## Reloading nginx from the host

The watcher reloads automatically on any file change. To force it:

```bash
docker compose exec nginx nginx -t            # validate
docker compose exec nginx nginx -s reload     # graceful reload, zero downtime
docker compose restart nginx                  # full restart (drops connections)
```

## HTTP API (admin, behind basic auth on `APP_PORT`)

| Method & path | Purpose |
|---|---|
| `GET /api/hosts` | list hosts (domain, A, B, active, enabled, managed) |
| `POST /api/import?apply=true` | import/update from CSV (dry-run without `apply`) |
| `POST /api/switch` `{domain,target?}` | flip one host to A/B (omit target = toggle) |
| `POST /api/switch-bulk` `{domains,target}` | batch cutover |
| `POST /api/enable` / `disable` `{domain}` | pause/resume a host |
| `POST /api/host/delete` `{domain}` | delete one host (committed) |
| `GET /api/host?domain=…` | raw `.conf` + parsed metadata (peek/editor) |
| `POST /api/host/save` `{domain,content}` | save a hand edit, commit, re-test |
| `GET /api/config-test` · `POST /api/config-test` | run `nginx -t` (no reload) |
| `GET /api/download?domain=…` · `GET /api/download-all` | download config(s) |
| `GET /api/export` | hosts → CSV |
| `GET /api/history` · `POST /api/rollback` `{hash}` | git log / checkpoint rollback |

## Security notes

- nginx: `server_tokens off`, TLS 1.2/1.3 + modern ciphers, slowloris timeouts, and a default
  server returning `444` for any unknown `Host` (only configured domains are served).
- **HSTS is off** deliberately — with a self-signed cert it would lock browsers out. Enable it
  in `nginx/snippets/ssl.conf` only after moving to CA-signed certs.
- The admin app is the component that writes nginx config, so the CSV is validated strictly
  (hostname/IPv4 only, no path traversal) and hand edits are BOM-stripped. It assumes a
  trusted network — keep `APP_PORT` off the public internet and behind basic auth.

## Project layout

```
docker-compose.yml          # two services, three volumes, one network
nginx/                      # hardened image: nginx.conf, snippets, entrypoint, watcher
app/
  server/                   # Express API: csv, validate, nginxHost (merge), gitStore, importer
  web/                      # Vite + React migration cockpit
examples/                   # sample CSVs
CLAUDE.md                   # architecture + invariants (read before changing behavior)
PLAN.md                     # build plan / feature backlog
```

## Known limitation

Hostname upstreams are resolved by nginx at config-load time, so a single **non-resolving
`alt_address` hostname** will fail `nginx -t` and block that batch's reload until fixed (via
the in-app editor). Backends given as **IP addresses** are unaffected. Request-time
resolution for hostname upstreams is on the backlog (see PLAN.md).
