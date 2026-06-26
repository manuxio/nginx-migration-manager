#!/usr/bin/env bash
# Manual-reload mode, POLLING. Changes are NOT auto-applied: when host files change the
# watcher runs `nginx -t` and marks the config "pending", but does NOT reload. A reload
# happens ONLY on an explicit .reload-request (the UI "Reload nginx" button).
#
# We poll (instead of inotify) because cross-container inotify events do not propagate on
# Docker Desktop bind mounts — the app container writes the .conf files, this container has
# to notice. Polling reads the files, so it works on bind mounts and native Linux alike.
set -uo pipefail

SITES=/etc/nginx/sites
OKF="$SITES/.reload-ok";  MSGF="$SITES/.reload-msg"     # last reload / currently-serving status
TOKF="$SITES/.test-ok";   TMSGF="$SITES/.test-msg"      # last config-test result
PENDING="$SITES/.pending"                                # "1" = changes awaiting a reload
REQ="$SITES/.reload-request"
TREQ="$SITES/.test-request"

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

# Content signature of all host files (name + content) -> detects any add/remove/edit.
sig() { { for f in "$SITES"/*.conf "$SITES"/*.conf.disabled; do [ -e "$f" ] && { echo "$f"; cat "$f"; }; done; } 2>/dev/null | md5sum; }
mt() { stat -c %Y "$1" 2>/dev/null || echo 0; }

# Startup: nginx already loaded the config (entrypoint validated + started it). Mark clean.
echo 0 > "$PENDING"
run_test "$OKF" "$MSGF" && printf 'config loaded\n' > "$MSGF"
run_test "$TOKF" "$TMSGF" || true
LAST_SIG="$(sig)"; LAST_REQ="$(mt "$REQ")"; LAST_TREQ="$(mt "$TREQ")"
echo "[watcher] polling $SITES (manual-reload mode) ..."

while true; do
  sleep 1
  m="$(mt "$REQ")";  if [ "$m" != "$LAST_REQ" ];  then LAST_REQ="$m";  do_reload; LAST_SIG="$(sig)"; continue; fi
  m="$(mt "$TREQ")"; if [ "$m" != "$LAST_TREQ" ]; then LAST_TREQ="$m"; run_test "$TOKF" "$TMSGF"; continue; fi
  s="$(sig)"; if [ "$s" != "$LAST_SIG" ]; then LAST_SIG="$s"; echo 1 > "$PENDING"; run_test "$TOKF" "$TMSGF"; echo "[watcher] change detected -> tested; reload pending"; fi
done
