# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this project is

A two-container Docker Compose stack that turns a CSV of domains into nginx
reverse-proxy hosts, with a small web UI to manage them.

- **`nginx`** — hardened reverse proxy. Listens on **80** and **443** (self-signed
  cert generated at container start). Secure by default; per-host configs are permissive.
- **`app`** — Node.js + React admin UI on **3000**. Reads/writes the per-host nginx
  config files and triggers reloads. Not hardened (assumed protected by the network),
  **but** it is the component that writes nginx config, so input validation here is a
  real security boundary — treat CSV/domain input as untrusted.

## The core invariants (do not break these)

1. **One file per DOMAIN; one `location` block per ROUTE.** `<domain>.conf` holds every route
   for that domain. A route = `domain` or `domain/path[/*]` (the CSV "domain-name" carries the
   optional path). The domain is the filename; paths live inside the file as `location` blocks,
   each with its own A/B upstreams + active selector. Path → location is **hybrid**: trailing
   `/*` → prefix `location /x/`; `*` elsewhere → regex `location ~ ^…` (`* → .*`); no `*` →
   exact `location = /x`; bare domain or `/` → `location /` (emitted last).
2. **Hand edits win, line by line.** Updates only rewrite the lines the app tagged as managed,
   **per route**: each managed block starts `# managed:route <path>` and its `# managed:primary
   /alt/active` + the `proxy_pass` (`# managed:upstream`) lines are the only ones rewritten.
   Untagged lines and entire hand-added `location` blocks are preserved verbatim. A file with no
   managed markers is fully manual and never touched. Routes already in a file but absent from a
   re-import are kept (never auto-removed). Legacy single-location files (no `# managed:route`)
   are read/merged as one implicit root route `/`.
3. **No mass delete.** Bulk import only creates/updates — a CSV that omits a domain does
   **not** remove it. Single-host delete IS allowed as a deliberate per-host action (GUI
   Delete button / `POST /api/host/delete`); it's committed to git, so an accidental delete
   is recoverable via Rollback. Never add a bulk/mass delete path.
4. **nginx is secure by default; hosts are permissive.** Server-level hardening (TLS,
   timeouts, `server_tokens off`, default-deny unknown `Host`) lives in `nginx.conf` and
   shared snippets. Per-host files stay permissive (websockets, large bodies, long
   timeouts, no restrictive response headers) so they "just work."
5. **The app never needs the Docker socket.** All nginx interaction goes through a file
   watcher inside the nginx container via the shared volume. Keep it that way.
6. **Manual reload — changes are NOT auto-applied.** On any host-file change the watcher runs
   `nginx -t` and marks the config **pending** (`.pending`), but does **not** reload. nginx
   reloads only on an explicit `.reload-request` (the UI "Reload nginx" button →
   `POST /api/reload`), which validates, applies, and clears pending. A failed `nginx -t`
   never reaches a reload, so a broken edit can't take nginx down — it just stays pending
   with the error shown. This lets an operator stage a batch of cutovers, confirm the config
   test passes, then apply them all with one reload.

## Layout

```
docker-compose.yml
nginx/
  Dockerfile
  entrypoint.sh                 # generate cert if missing, start watcher, exec nginx
  watcher.sh                    # inotifywait: on change -> nginx -t + set .pending (NO reload);
                                #              reload only on .reload-request (clears pending)
  nginx.conf                    # hardened http{} + default-deny server (444)
  snippets/
    ssl.conf                    # TLS 1.2/1.3, modern ciphers, session cache
    proxy.conf                  # permissive proxy params (Upgrade/Connection, timeouts, body)
    security-headers.conf       # OPT-IN per host, off by default (keeps hosts permissive)
  templates/
    proxy-host.conf.tmpl
app/
  Dockerfile
  package.json
  server/                       # express API
    index.js
    csv.js                      # parse + validate CSV
    generator.js                # render template, hash, write
    manifest.js                 # read/write manifest.json, fingerprint logic
  web/                          # React (Vite)
```

## Volumes (host bind mounts under `./data/`)

- `./data/nginx` → the **whole `/etc/nginx`** for the nginx container (config + `snippets/` +
  `sites/` + `certs/`). On first boot the host folder is empty, so the entrypoint **seeds**
  it from the image's stashed defaults (`/usr/local/share/nginx-defaults`) when
  `nginx.conf` is missing; existing files (a populated `sites/`) are left untouched.
  Everything is editable directly on the host.
- `./data/nginx/sites` → also mounted into the **app** at `/etc/nginx/sites` (same files).
  App writes host configs + the git repo here; nginx includes `sites/*.conf`.
- `./data/app` → app-only `/data`: `manifest.json`, `served-commit`, backups.

(`nginx.conf` and `snippets/` are baked into the image *and* seeded to the host on first
boot; once seeded, editing them is on you — image updates won't overwrite the host copy.)

## Hand-edit handling (the tricky part) — marker-based field merge

The app does NOT regenerate whole files on update. It only rewrites lines it tagged, scoped
to each ROUTE. A domain file holds one managed block per route; each block has its own
PRIMARY + ALT upstream and ACTIVE selector:

```nginx
    server_name www.example.com;            # managed:server_name

    # managed:route /api/*
    location /api/ {
        # managed:primary 10.0.0.5:8080
        # managed:alt 10.0.1.5:8080
        # managed:active primary
        proxy_pass http://10.0.0.5:8080;    # managed:upstream
    }

    # managed:route /
    location / { … same markers … }
```

The GUI "→ A / → B" buttons (and `POST /api/switch {domain, path}`) flip one route's `active`,
rewriting only that block's `# managed:active` + `proxy_pass`. On import the `active` selection
is **sticky** per route (a switch is not undone by re-importing); primary/alt values refresh
from the CSV. `switchRoute` / `mergeDomain` are keyed by the route's path.

Mass-update algorithm (per CSV row):
- sanitize domain → reject anything that isn't a valid hostname (no `/`, `..`, spaces, etc.)
- no file yet → **create** full file from the template (markers included).
- file exists, has managed markers → surgically rewrite only the marked lines (preserve
  indentation, preserve every other line). Status `updated` if the upstream changed, else
  `unchanged`.
- file exists, NO managed markers → fully hand-authored → **skip (manual)**, never touch.
- domains present on disk but absent from CSV → leave untouched (**no delete**).

`manifest.json` is the desired-state record (`{ "<domain>": { address, port, source,
updatedAt } }`) used for export and listing — it is NOT the merge gate; the inline markers
are. Git history (below) is the audit trail. Always return a per-domain report:
`created / updated / unchanged / skipped-manual / invalid`.

## Git-backed history

The `proxy_conf` volume (`/etc/nginx/sites`) is a git repo. On startup the app runs
`git init` if needed. After every apply it `git add -A && git commit` with a summary
message. This gives a free audit log, `git status` as a redundant hand-edit detector, and
one-command rollback (`git revert` / `git checkout`). `GET /api/history` exposes the log.

## CSV format

```csv
"domain-name","address","port","alt_address","alt_port"
"www.example.com","10.0.0.1","80","10.0.1.1","80"
"www.example.com/api/*","10.0.0.5","8080","10.0.1.5","8080"
```
- `domain-name` = `host` or `host/path[/*]`. The host is the filename; the path becomes a
  `location` (hybrid mapping). Multiple rows with the same host = multiple routes in one file.
- `address`/`alt_address` = IPv4 or hostname. `alt_*` optional (no alt → that route can't switch).
- `port`/`alt_port` optional, **default 80**.
- Validate every row: host must be a clean hostname (filename guard); path must match a safe
  charset (`/[A-Za-z0-9._~%\-/*]*`) so it can't inject nginx directives.

## Commands

```bash
docker compose up -d --build      # start stack
docker compose logs -f nginx      # watch reload/validation results
docker compose exec nginx nginx -t  # manual config test
```

App API (served on :3000):
- `POST /api/import`   (CSV body or `{csv}`) → dry-run unless `?apply=true`
- `GET  /api/hosts`    → list of `{domain, file, enabled, managed, routes:[{path, primary, alt, active, activeUpstream}]}`
- `POST /api/switch`   `{domain, path, target?}` → flip one route to A/B (omit target = toggle)
- `POST /api/switch-bulk` `{items:[{domain, path}], target}` → batch cutover; routes grouped per file
- `POST /api/host/upstream` `{domain, path, which:'primary'|'alt', value:'addr[:port]'}` → inline-edit
  one route's backend (double-click in the GUI); reuses the marker merge. `''` clears alt
- `POST /api/host/rename` `{domain, newDomain}` → rename a host (file + `server_name`)
- `POST /api/host/route` `{domain, path, newPath}` → rename a route's path (marker + `location`)
- `GET  /api/host?domain=…` → raw `.conf` text + parsed `routes` (the in-GUI peek/editor)
- `POST /api/host/save` `{domain, content}` → write a hand edit, commit a checkpoint, run
  `nginx -t`; BOM-stripped. The edit becomes **pending** (not applied until reload).
- `GET  /api/status` → `{ reload:{ok,message}, test:{ok,message}, pending }` — what's serving,
  the config-test of the pending changes, and whether a reload is owed.
- `GET  /api/history` → `{ history:[{hash,date,message}], served, head }` — `served` = short
  hash nginx is currently running (HEAD at last reload), recorded on success in `served-commit`
- `POST /api/rollback` `{hash}` → **`git reset --hard`** to that checkpoint (discards all later
  changes; recoverable via `git reflog` until gc). Becomes pending like any other change.
- `POST /api/config-test` → run `nginx -t` on demand (no reload) → `{ok, message}`
- `POST /api/reload` → **explicitly apply** the pending config (writes `.reload-request`;
  validates, reloads, clears pending) → `{ok, message}`
- `POST /api/enable` / `POST /api/disable`  `{domain}` → rename `.conf` ↔ `.conf.disabled`
- `POST /api/host/delete` `{domain}` → delete one host file + commit (single-host only; git-recoverable)
- `GET  /api/download?domain=…`  → one host's live `.conf`
- `GET  /api/download-all` → `.tar.gz` of all live host files (uses `tar` in the app image)
- `GET  /api/export`   → CSV of current hosts (5 columns, parsed from the live files)

## Conventions

- Generated host files carry a header: `# managed-by: nginx-managed` + domain/upstream.
  Treat that header as informational; the manifest fingerprint is the source of truth.
- Keep server-level security changes in `nginx.conf`/`snippets/ssl.conf`. Keep anything
  that should be loose in `snippets/proxy.conf`.
- Default HSTS is **OFF** — self-signed cert + HSTS would hard-block browsers. Only turn
  it on once real (CA-signed) certs are in play.
