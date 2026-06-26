#!/usr/bin/env bash
set -euo pipefail

CERT_DIR=/etc/nginx/certs
CRT="$CERT_DIR/server.crt"
KEY="$CERT_DIR/server.key"
CN="${CERT_CN:-localhost}"

mkdir -p "$CERT_DIR" /etc/nginx/sites

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
