#!/bin/sh
# Scheduler for the timeline-sync container: routine sync, then (optionally) name any new
# places with the capped, cached headless resolver, then sleep. timeline-mcp notices the new
# export on its own (it checks the file's mtime before serving requests).
INTERVAL="${TIMELINE_SYNC_INTERVAL_SECONDS:-21600}"   # 6 h: the phone's backup only lands every few hours anyway

while :; do
  echo "[timeline-sync-loop] $(date -u +%FT%TZ) sync starting" >&2
  timeline-sync sync || echo "[timeline-sync-loop] sync failed; last-known-good export kept (see above)" >&2
  if [ "${TIMELINE_AUTO_NAMES:-true}" = "true" ]; then
    timeline-sync names --method "${TIMELINE_NAMES_METHOD:-browser}" \
      || echo "[timeline-sync-loop] names step skipped/failed (see above)" >&2
  fi
  echo "[timeline-sync-loop] next run in ${INTERVAL}s" >&2
  sleep "$INTERVAL"
done
