#!/usr/bin/env bash
# Convenience wrapper: start the whole local dev environment.
#   ./dev.sh            start auth + both MCP servers (foreground; Ctrl-C stops)
#   ./dev.sh test       run all automated tests
#   ./dev.sh e2e        run the end-to-end MCP+OAuth check
#   ./dev.sh seed       generate synthetic data for both MCPs
set -euo pipefail
cd "$(dirname "$0")"
[ -d node_modules ] || npm install
case "${1:-up}" in
  up)   exec npm run dev ;;
  test) exec npm test ;;
  e2e)  exec npm run test:e2e ;;
  seed) exec npm run seed ;;
  *) echo "usage: ./dev.sh [up|test|e2e|seed]"; exit 1 ;;
esac
