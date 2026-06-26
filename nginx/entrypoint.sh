#!/usr/bin/env bash
set -euo pipefail

NGINX_DIR=/etc/nginx
DEFAULTS=/usr/local/share/nginx-defaults
CERT_DIR="$NGINX_DIR/certs"
CRT="$CERT_DIR/server.crt"
KEY="$CERT_DIR/server.key"
CN="${CERT_CN:-localhost}"

# Seed a bind-mounted /etc/nginx from the image defaults on first boot (nginx.conf missing).
# Existing files (e.g. a populated sites/ from a previous run) are left untouched.
if [[ ! -f "$NGINX_DIR/nginx.conf" ]]; then
  echo "[entrypoint] $NGINX_DIR/nginx.conf missing — seeding from image defaults ..."
  mkdir -p "$NGINX_DIR"
  cp -a "$DEFAULTS/." "$NGINX_DIR/"
fi

mkdir -p "$CERT_DIR" "$NGINX_DIR/sites"

# Generate a self-signed cert once (persisted in the certs volume).
if [[ ! -f "$CRT" || ! -f "$KEY" ]]; then
  echo "[entrypoint] generating self-signed certificate (CN=$CN) ..."
  openssl req -x509 -nodes -newkey rsa:2048 \
    -keyout "$KEY" -out "$CRT" \
    -days 3650 -subj "/CN=$CN" \
    -addext "subjectAltName=DNS:${CN},DNS:localhost,IP:127.0.0.1"
  chmod 600 "$KEY"
  echo "[entrypoint] certificate written to $CRT"
fi

# Fail fast if base config is broken.
nginx -t

echo "[entrypoint] starting config watcher ..."
/usr/local/bin/watcher.sh &

echo "[entrypoint] starting nginx ..."
exec nginx -g 'daemon off;'
