#!/bin/bash
# Persistent Chromium signed into the Timeline Google account, viewable/drivable over noVNC
# (container port 6080), plus a watcher that re-mints the Timeline master token when Google
# revokes it. One-time setup: open noVNC, sign in at accounts.google.com, let Chromium save the
# password. See DOCKER.md "Automatic Timeline re-auth".
set -u -o pipefail
: "${TIMELINE_GOOGLE_EMAIL:?set TIMELINE_GOOGLE_EMAIL}"
PROFILE=/data/browser/google-timeline
STATUS=/data/timeline/state/sync-status.json
REAUTH_MIN_GAP=${REAUTH_MIN_GAP:-3600}
REAUTH_CHECK_EVERY=${REAUTH_CHECK_EVERY:-600}
mkdir -p "$PROFILE" && chmod 700 /data/browser "$PROFILE"
rm -f "$PROFILE"/Singleton*
# The display + noVNC come from the image entrypoint (this service runs with BROWSER_MODE=vnc).
[ -n "${DISPLAY:-}" ] || { echo "[google-browser] needs BROWSER_MODE=vnc" >&2; exit 1; }

auth_expired() {
  python3 - "$STATUS" <<'PY'
import json, sys
try:
    s = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(1)
sys.exit(0 if (s.get("auth") or {}).get("state") == "expired" else 1)
PY
}

# Watcher: when the sync reports the master token as expired, get a fresh oauth_token from this
# browser and exchange it. The token goes from google-reauth's stdout straight into
# `timeline-sync auth`; it is never written to a file or a log. At most one try per REAUTH_MIN_GAP.
( sleep 60; last=0; while true; do
    if auth_expired; then
      now=$(date +%s)
      if [ $((now - last)) -ge "$REAUTH_MIN_GAP" ]; then
        last=$now
        echo "[google-browser] Timeline auth expired; re-authenticating from the browser session" >&2
        if node /app/tools/google-reauth.mjs \
             | timeline-sync auth --email "$TIMELINE_GOOGLE_EMAIL" --oauth-token-stdin >/dev/null; then
          echo "[google-browser] master token renewed; running a sync" >&2
          timeline-sync sync >/dev/null 2>&1 && echo "[google-browser] sync ok" || echo "[google-browser] sync after re-auth failed (see timeline-sync logs)" >&2
        else
          echo "[google-browser] re-auth FAILED: sign in over noVNC (see google-reauth messages above)" >&2
        fi
      fi
    fi
    sleep "$REAUTH_CHECK_EVERY"
  done ) &

while true; do
  /usr/bin/chromium --user-data-dir="$PROFILE" --password-store=basic --no-first-run \
    --no-default-browser-check --no-sandbox \
    --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 \
    --window-size=1400,900 https://myaccount.google.com/ >/dev/null 2>&1
  echo "[google-browser] chromium exited; restarting in 5s" >&2
  rm -f "$PROFILE"/Singleton*
  sleep 5
done
