#!/bin/sh
# Start one backend process role from the shared image: ROLE=web | worker | egress.
set -e
case "$ROLE" in
  web) exec node --enable-source-maps apps/web/dist/server.js ;;
  worker) exec node --enable-source-maps apps/worker/dist/worker.js ;;
  egress) exec node --enable-source-maps apps/egress/dist/server.js ;;
  *) echo "Unknown ROLE '$ROLE' (expected web, worker or egress)" >&2; exit 64 ;;
esac
