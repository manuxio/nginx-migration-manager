#!/usr/bin/env bash
# Manual reload helper (validate then graceful reload).
# From the host:  docker compose exec nginx reload.sh
set -euo pipefail
nginx -t && nginx -s reload && echo "reloaded"
