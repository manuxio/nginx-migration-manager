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

# Fail fast if the config is broken.
nginx -t

echo "[entrypoint] starting config watcher ..."
/usr/local/bin/watcher.sh &

echo "[entrypoint] starting nginx (HTTP/80 only) ..."
exec nginx -g 'daemon off;'
