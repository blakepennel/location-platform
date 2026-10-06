# location-platform — thin task runner over the npm scripts.
.PHONY: install dev test e2e seed typecheck leak-scan clean stop
install: ; npm install
dev: ; npm run dev                 ## start auth + both MCP servers (Ctrl-C to stop)
test: ; npm test                   ## all automated tests (node + python)
e2e: ; npm run test:e2e            ## end-to-end MCP + OAuth check
seed: ; npm run seed               ## synthetic data for both MCP servers
typecheck: ; npm run typecheck
leak-scan: ; npm run leak-scan     ## secret / real-coordinate scan
