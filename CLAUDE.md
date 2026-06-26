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

1. **One file per proxy host.** `nginx/sites/<domain>.conf`. The domain is the filename.
2. **Hand edits win, line by line.** Mass updates only rewrite the lines the app tagged as
   managed (the `proxy_pass` line carries a `# managed:upstream` marker; `server_name`
   carries `# managed:server_name`). Every untagged line — including anything you added by
   hand — is preserved **verbatim**. A host file containing no managed markers is treated
   as fully manual and is never touched. To "pin" an upstream so updates skip it, delete
   the marker comment on that line.
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

## Volumes (shared state)

- `proxy_conf` → mounted at `/etc/nginx/sites` in **both** containers. App writes, nginx
  reads, watcher tails it. nginx includes it: `include /etc/nginx/sites/*.conf;`
- `certs` → `/etc/nginx/certs`. Entrypoint writes the self-signed cert; nginx reads it.
- `app_data` → app-only. Holds `manifest.json`, uploaded CSVs, and backups.

## Hand-edit handling (the tricky part) — marker-based field merge

The app does NOT regenerate whole files on update. It only rewrites lines it tagged.
Each host has a PRIMARY and an ALT upstream plus an ACTIVE selector; the `proxy_pass`
line points at whichever is active. Generated host files carry inline markers:

```nginx
    server_name app.example.com;            # managed:server_name
    location / {
        # managed:primary 10.0.0.10:8080
        # managed:alt 10.0.0.11:8080
        # managed:active primary
        proxy_pass http://10.0.0.10:8080;   # managed:upstream
    }
```

The GUI "→ primary / → alt" buttons (and `POST /api/switch`) flip `active`, rewriting only
the `# managed:active` and `proxy_pass` lines — this failover switch is the project's
primary use case. On mass-import the `active` selection is **sticky** (a switch is not
undone by re-importing), while the primary/alt values are refreshed from the CSV.

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
```
- `address`/`alt_address` = IPv4 or hostname. `alt_*` optional (no alt → switch disabled).
- `port`/`alt_port` optional, **default 80**.
- Validate every row; surface bad rows, don't write them. The domain doubles as the
  filename, so it's the path-traversal guard — reject anything not a clean hostname.

## Commands

```bash
docker compose up -d --build      # start stack
docker compose logs -f nginx      # watch reload/validation results
docker compose exec nginx nginx -t  # manual config test
```

App API (served on :3000):
- `POST /api/import`   (CSV body or `{csv}`) → dry-run unless `?apply=true`
- `GET  /api/hosts`    → list (domain, primary, alt, active, activeUpstream, enabled, managed)
- `POST /api/switch`   `{domain, target?}` → forward to primary/alt (omit target = toggle)
- `POST /api/switch-bulk` `{domains:[…], target}` → batch cutover; unswitchable hosts reported, not fatal
- `POST /api/host/upstream` `{domain, which:'primary'|'alt', value:'addr[:port]'}` → inline-edit one
  backend (double-click in the GUI); reuses the marker merge, keeps active sticky. `''` clears alt
- `GET  /api/host?domain=…` → raw `.conf` text + parsed A/B/active (the in-GUI peek/editor)
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
