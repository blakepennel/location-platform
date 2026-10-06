#!/bin/sh
# Container entrypoint.
#   BROWSER_MODE=headless (default): nothing extra; Chromium runs headless.
#   BROWSER_MODE=vnc: start a virtual display (Xvfb + fluxbox), expose it over VNC inside the
#     container only, and serve it to your web browser with noVNC on port 6080
#     (http://localhost:6080/vnc.html once the port is published). Chromium then opens visibly.
set -e

if [ "${BROWSER_MODE:-headless}" = "vnc" ]; then
  export DISPLAY="${DISPLAY:-:99}"
  Xvfb "$DISPLAY" -screen 0 "${VNC_GEOMETRY:-1440x900x24}" -nolisten tcp >/tmp/xvfb.log 2>&1 &
  # wait for the X server socket before starting clients
  i=0
  while [ ! -S "/tmp/.X11-unix/X${DISPLAY#:}" ] && [ $i -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
  fluxbox >/tmp/fluxbox.log 2>&1 &
  if [ -n "${VNC_PASSWORD:-}" ]; then
    mkdir -p "$HOME/.vnc"
    x11vnc -storepasswd "$VNC_PASSWORD" "$HOME/.vnc/passwd" >/dev/null 2>&1
    AUTH="-rfbauth $HOME/.vnc/passwd"
  else
    AUTH="-nopw"
  fi
  # -localhost: raw VNC is reachable only inside the container; noVNC is the only way in.
  # shellcheck disable=SC2086
  x11vnc -display "$DISPLAY" -forever -shared -localhost -rfbport 5900 $AUTH -quiet >/tmp/x11vnc.log 2>&1 &
  websockify --web /usr/share/novnc 6080 localhost:5900 >/tmp/novnc.log 2>&1 &
  echo "[lp] browser display: open http://localhost:<published port>/vnc.html (container port 6080)" >&2
fi

exec "$@"
