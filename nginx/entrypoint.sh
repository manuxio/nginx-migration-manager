#!/usr/bin/env bash
set -euo pipefail

NGINX_DIR=/etc/nginx
DEFAULTS=/usr/local/share/nginx-defaults

# Seed a bind-mounted /etc/nginx from the image defaults on first boot (nginx.conf missing).
# Existing files (a populated sites/) are left untouched.
if [[ ! -f "$NGINX_DIR/nginx.conf" ]]; then
  echo "[entrypoint] $NGINX_DIR/nginx.conf missing — seeding from image defaults ..."
  mkdir -p "$NGINX_DIR"
  cp -a "$DEFAULTS/." "$NGINX_DIR/"
fi
mkdir -p "$NGINX_DIR/sites"

# Restore newer shipped files that an already-seeded volume may be missing (idempotent —
# only copies when absent, so local edits are never clobbered). error.html backs the
# upstream-down page; snippets/upstream-error.conf is the serving location each host includes.
for f in error.html snippets/upstream-error.conf; do
  if [[ ! -e "$NGINX_DIR/$f" ]]; then
    mkdir -p "$NGINX_DIR/$(dirname "$f")"
    cp "$DEFAULTS/$f" "$NGINX_DIR/$f" && echo "[entrypoint] restored missing $f"
  fi
done

# Fail fast if the config is broken.
nginx -t

echo "[entrypoint] starting config watcher ..."
/usr/local/bin/watcher.sh &

echo "[entrypoint] starting nginx (HTTP/80 only) ..."
exec nginx -g 'daemon off;'
