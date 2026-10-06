#!/bin/bash
# CHROME_PATH points here. Upstream's scripts launch Chromium through puppeteer-core, and
# resolve_names.js always asks for headless mode. When BROWSER_MODE=vnc and the virtual display
# is running, drop the --headless flag so the same browser opens visibly on the noVNC screen,
# without editing upstream. In headless mode the arguments pass through unchanged.
if [[ "${BROWSER_MODE:-headless}" == "vnc" && -z "${DISPLAY:-}" && -S /tmp/.X11-unix/X99 ]]; then
  export DISPLAY=:99   # `docker compose exec` sessions don't inherit the entrypoint's DISPLAY
fi
args=()
for a in "$@"; do
  if [[ "${BROWSER_MODE:-headless}" == "vnc" && -n "${DISPLAY:-}" && "$a" == --headless* ]]; then
    continue
  fi
  args+=("$a")
done
exec /usr/bin/chromium "${args[@]}"
