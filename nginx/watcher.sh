#!/usr/bin/env bash
# Watches the sites dir. On host-file changes (or a .reload-request) it validates and
# reloads nginx — a broken hand edit fails `nginx -t` and is skipped, last-good stays live.
# On a .test-request it runs `nginx -t` ONLY (no reload) and records the result.
set -uo pipefail

SITES=/etc/nginx/sites
OKF="$SITES/.reload-ok";  MSGF="$SITES/.reload-msg"
TOKF="$SITES/.test-ok";   TMSGF="$SITES/.test-msg"

# run_test <ok-file> <msg-file>  -> writes 1/0 + message, returns 0 if config valid
run_test() {
  local out
  if out="$(nginx -t 2>&1)"; then
    echo 1 > "$1"; printf 'config valid\n' > "$2"; return 0
  else
    echo 0 > "$1"; printf '%s\n' "$out" > "$2"; return 1
  fi
}

reload() {
  if run_test "$OKF" "$MSGF"; then
    nginx -s reload
    printf 'config valid — reloaded\n' > "$MSGF"
    echo "[watcher] reloaded ok"
  else
    echo "[watcher] nginx -t FAILED — keeping last-good config"
    cat "$MSGF"
  fi
}

echo "[watcher] watching $SITES ..."
reload   # establish initial status

while true; do
  # Block until one change; print its filename. Result files are excluded to avoid loops,
  # but .reload-request / .test-request are NOT excluded so the app can trigger us.
  f="$(inotifywait -q -r -e modify,create,close_write,move,delete "$SITES" \
        --format '%f' --exclude '(\.reload-(ok|msg)$|\.test-(ok|msg)$|\.git/|\.tmp$)' 2>/dev/null || true)"
  case "$f" in
    *test-request*) run_test "$TOKF" "$TMSGF"; echo "[watcher] config test requested -> $(cat "$TOKF")" ;;
    *)              sleep 1; reload ;;
  esac
done
