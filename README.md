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

## Deploy from prebuilt images (GHCR)

For servers you don't want to build on, CI publishes both images to GitHub Container
Registry (public — no login to pull):

```text
ghcr.io/manuxio/nginx-migration-manager/nginx
ghcr.io/manuxio/nginx-migration-manager/app
```

Tags: `latest`, `sha-<short>`, and `vX.Y.Z` on release tags. The host only needs Docker plus
`docker-compose.yml` and `.env` (scp them over, or clone the repo) — no source build:

```bash
docker compose pull          # fetch the published images
docker compose up -d         # run them; no build on the host
```

Pin a version with `IMAGE_TAG=v1.2.3` in `.env`; update later with
`docker compose pull && docker compose up -d`. The workflow
(`.github/workflows/publish.yml`) rebuilds and pushes on every push to `main` and on `v*`
tags. (One-time: after the first CI run, set each package's visibility to **Public** in its
GitHub package settings.)

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
  no B are skipped and reported. **Staged, not applied** (see Reload below).
- **→ A / → B** (per host) — stage a flip of one host's `proxy_pass`. The choice is **sticky**:
  re-importing the CSV refreshes addresses but never undoes a cutover.
- **Disable / Enable** — pause a host (`.conf` ↔ `.conf.disabled`) without deleting.
- **Peek / Edit** — view *and hand-edit* a host's live `.conf` in-app; Save commits a
  checkpoint and runs `nginx -t`, reporting pass/fail immediately (pending until you reload).
- **Delete** — remove a single host (committed → recoverable via Rollback). No bulk delete.
- **Test config** — run `nginx -t` on demand (no reload) and show the result.
- **Reload nginx** — changes are **not auto-applied**: every change runs `nginx -t` and turns
  the **Reload** button amber to flag pending changes. Click it to apply them all at once
  (zero-downtime). This lets you stage a whole batch, confirm the config test is green, then
  cut over with a single deliberate reload.
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

- **Manual reload.** Changes are never auto-applied. A watcher inside the nginx container
  runs `nginx -t` on every change and marks the config *pending*; nginx reloads only when you
  click **Reload nginx**. A broken file (or bad hand edit) fails the test, stays pending, and
  is surfaced in the UI one click from the in-app editor — it can't take the proxy down.
- Every change (import, cutover, enable/disable, edit, delete) is committed to a git repo in
  the config volume. The **History** panel shows the last 50 commits with timestamps.
- **Rollback** restores the whole config to a chosen checkpoint and **discards everything
  after it** (`git reset --hard`; still recoverable via `git reflog` until gc).
- The app never touches the Docker socket — it signals the nginx container through the shared
  volume only.

## Reloading nginx from the host

Normally you reload from the UI (**Reload nginx**). To do it directly on the host:

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
| `GET /api/status` | `{reload, test, pending}` — serving status, pending test, reload owed |
| `POST /api/config-test` | run `nginx -t` on demand (no reload) |
| `POST /api/reload` | apply the pending config (validate + reload, clear pending) |
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

## Data & persistence

Runtime state lives in host bind mounts next to `docker-compose.yml`:

```
data/nginx/        # the whole /etc/nginx — nginx.conf, snippets/, sites/, certs/, …
data/nginx/sites/  # generated host configs + their git history (shared with the app)
data/app/          # manifest.json, served-commit, backups
```

On **first boot** the `data/nginx` folder is empty, so the nginx container seeds it from the
image's baked-in defaults (when `nginx.conf` is missing). After that you can edit any file in
`data/nginx/` directly on the host. Back it up by backing up `data/` (files are root-owned).
Note: once seeded, `nginx.conf`/`snippets/` are your copy — image updates won't overwrite them.

## Project layout

```
docker-compose.yml          # two services, host bind mounts (./data), one network
nginx/                      # hardened image: nginx.conf, snippets, entrypoint (seeds), watcher
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
