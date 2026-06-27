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

# Add files an already-seeded volume may be MISSING — never overwrites, so hand edits win.
for f in error.html snippets/upstream-error.conf; do
  if [[ ! -e "$NGINX_DIR/$f" ]]; then
    mkdir -p "$NGINX_DIR/$(dirname "$f")"
    cp "$DEFAULTS/$f" "$NGINX_DIR/$f" && echo "[entrypoint] restored missing $f"
  fi
done

# nginx.conf: ADD only the managed blocks it's missing (server_names_hash, health-check,
# error_page, stub_status). Existing lines are never rewritten, so hand edits are preserved.
# Built into a temp file, validated with `nginx -t -c`, swapped in only if it passes.
NC="$NGINX_DIR/nginx.conf"
if [[ -f "$NC" ]] && grep -q 'include /etc/nginx/sites/' "$NC"; then
  hasHash=$(grep -q 'server_names_hash_bucket_size' "$NC" && echo 1 || echo 0)
  hasHC=$(grep -q '/healthz' "$NC" && echo 1 || echo 0)
  hasErr=$(grep -q 'proxy_intercept_errors' "$NC" && echo 1 || echo 0)
  hasStub=$(grep -q 'stub_status' "$NC" && echo 1 || echo 0)
  if [[ "$hasHash$hasHC$hasErr$hasStub" != 1111 ]]; then
    if awk -v hash="$hasHash" -v hc="$hasHC" -v err="$hasErr" -v stub="$hasStub" '
        { line = $0 }
        (!hd && hash=="0" && line ~ /^[[:space:]]*http[[:space:]]*\{/) {
          print line; print "    server_names_hash_bucket_size 180;"; hd=1; next
        }
        (!hcd && hc=="0" && line ~ /^[[:space:]]*return 444;[[:space:]]*$/) {
          print "        location = /healthz { access_log off; return 200 \"ok\\n\"; }"
          print "        location / {"
          print "            if ($http_user_agent ~ \"GoogleHC\") { return 200 \"ok\\n\"; }"
          print "            return 444;"
          print "        }"
          hcd=1; next
        }
        (!sid && line ~ /include \/etc\/nginx\/sites\//) {
          if (err=="0")  { print "    proxy_intercept_errors on;"; print "    error_page 502 503 504 /__upstream_down.html;"; print "" }
          if (stub=="0") { print "    server { listen 8080; location = /stub_status { stub_status; access_log off; } location / { return 404; } }"; print "" }
          sid=1
        }
        { print line }
      ' "$NC" > "$NC.new" && nginx -t -c "$NC.new" >/dev/null 2>&1; then
      mv "$NC.new" "$NC"
      echo "[entrypoint] nginx.conf: added missing managed blocks"
    else
      rm -f "$NC.new"
      echo "[entrypoint] WARN: nginx.conf auto-patch failed nginx -t — left unchanged"
    fi
  fi
fi

# error.html: strip the "Pubblica Amministrazione" subtitle in place (keep everything else).
EH="$NGINX_DIR/error.html"
if [[ -f "$EH" ]] && grep -q 'Pubblica Amministrazione' "$EH"; then
  sed -i 's/Pubblica Amministrazione//g' "$EH"
  echo "[entrypoint] error.html: removed 'Pubblica Amministrazione'"
fi

# Fail fast if the config is broken.
nginx -t

echo "[entrypoint] starting config watcher ..."
/usr/local/bin/watcher.sh &

echo "[entrypoint] starting nginx (HTTP/80 only) ..."
exec nginx -g 'daemon off;'
