#!/data/data/com.termux/files/usr/bin/bash
set -u
ADB_SERIAL=127.0.0.1:5556
API_PKG=com.termux.api
TERMUX_PKG=com.termux
TIMEOUT_S=${TERMUX_API_PROBE_TIMEOUT_S:-6}

cleanup_stale() {
  ps -eo pid,etimes,args 2>/dev/null | awk -v t="$((TIMEOUT_S*2))" '
    /\/libexec\/termux-api/ && $2 ~ /^[0-9]+$/ && $2 > t {print $1}
  ' | while read -r pid; do kill "$pid" 2>/dev/null || true; done
}

pkg_uid() { adb -s "$ADB_SERIAL" shell pm list packages -U 2>/dev/null | awk -v p="package:$1" '$1==p {sub("uid:","",$2); print $2; exit}'; }
pkg_sig() { adb -s "$ADB_SERIAL" shell dumpsys package "$1" 2>/dev/null | sed -n 's/.*signatures:\[\([^]]*\)\].*//p' | head -1; }

cleanup_stale
if ! adb -s "$ADB_SERIAL" shell pm path "$API_PKG" >/dev/null 2>&1; then
  printf '{"status":"missing","package":"%s"}\n' "$API_PKG"; exit 2
fi
tu=$(pkg_uid "$TERMUX_PKG"); au=$(pkg_uid "$API_PKG")
ts=$(pkg_sig "$TERMUX_PKG"); as=$(pkg_sig "$API_PKG")
if [ -z "$tu" ] || [ "$tu" != "$au" ] || [ -z "$ts" ] || [ "$ts" != "$as" ]; then
  printf '{"status":"incompatible","same_uid":false,"same_signature":false}\n'; exit 3
fi

tmp="${TMPDIR:-/data/data/com.termux/files/usr/tmp}/termux-api-probe.$$"
if timeout "$TIMEOUT_S" termux-battery-status >"$tmp" 2>/dev/null; then
  rm -f "$tmp"
  if timeout "$TIMEOUT_S" termux-job-scheduler --pending >/dev/null 2>&1; then
    printf '{"status":"healthy","same_uid":true,"same_signature":true,"job_scheduler":true}\n'; exit 0
  fi
  cleanup_stale
  printf '{"status":"degraded","same_uid":true,"same_signature":true,"battery_api":true,"job_scheduler":false,"reason":"job_scheduler_timeout"}\n'; exit 4
else
  rc=$?
fi
rm -f "$tmp"; cleanup_stale
printf '{"status":"degraded","same_uid":true,"same_signature":true,"battery_api":false,"job_scheduler":false,"reason":"android16_termux_api_transport_hang","probe_rc":%s}\n' "$rc"
exit 4
