#!/usr/bin/env bash
# Manual-reload mode. Changes are NOT auto-applied: when a host file changes the watcher
# runs `nginx -t` (config test) and marks the config "pending", but does NOT reload.
# A reload happens ONLY on an explicit .reload-request (the UI "Reload nginx" button),
# which validates + applies the pending config and clears the pending flag.
set -uo pipefail

SITES=/etc/nginx/sites
OKF="$SITES/.reload-ok";  MSGF="$SITES/.reload-msg"     # last reload / currently-serving status
TOKF="$SITES/.test-ok";   TMSGF="$SITES/.test-msg"      # last config-test result
PENDING="$SITES/.pending"                                # "1" = changes awaiting a reload

run_test() {  # <ok-file> <msg-file> ; returns 0 if config is valid
  local out
  if out="$(nginx -t 2>&1)"; then
    echo 1 > "$1"; printf 'config valid\n' > "$2"; return 0
  else
    echo 0 > "$1"; printf '%s\n' "$out" > "$2"; return 1
  fi
}

do_reload() {  # explicit reload: validate, apply, clear pending
  if run_test "$OKF" "$MSGF"; then
    nginx -s reload
    echo 0 > "$PENDING"
    printf 'config valid — reloaded\n' > "$MSGF"
    echo 1 > "$TOKF"; printf 'config valid\n' > "$TMSGF"
    echo "[watcher] reloaded; pending cleared"
  else
    echo "[watcher] reload requested but nginx -t FAILED; keeping last-good (still pending)"
  fi
}

# Startup: nginx already loaded the config (entrypoint ran nginx -t then started it). Mark clean.
echo 0 > "$PENDING"
run_test "$OKF" "$MSGF" && printf 'config loaded\n' > "$MSGF"
run_test "$TOKF" "$TMSGF" || true
echo "[watcher] watching $SITES (manual-reload mode) ..."

while true; do
  # One change at a time. Result/pending files are excluded to avoid loops; the request
  # files (.reload-request / .test-request) are NOT excluded so the app can signal us.
  f="$(inotifywait -q -r -e modify,create,delete,move,close_write "$SITES" \
        --format '%f' --exclude '(\.reload-(ok|msg)$|\.test-(ok|msg)$|\.pending$|\.git/|\.tmp$)' 2>/dev/null || true)"
  case "$f" in
    *test-request*)   run_test "$TOKF" "$TMSGF" ;;
    *reload-request*) do_reload ;;
    *)                echo 1 > "$PENDING"          # a host file changed -> needs a reload
                      sleep 1                       # debounce a burst of writes
                      run_test "$TOKF" "$TMSGF"     # validate the pending config (no reload)
                      echo "[watcher] change detected -> tested; reload pending" ;;
  esac
done
