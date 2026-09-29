#!/bin/sh
# Pre-flight checks of the BoC host (docs/RPI.md). Run as the boc user:
#
#   sh ~/boc/deploy/rpi/check.sh ~/boc/var/event-2026.config.json [--probe]
#
# Offline except for the optional --probe, which runs the solver executor probe
# with the toolchains (synthetic data, no credentials, no model or AoC traffic).
# It never reads or prints credential contents.
set -u

CONFIG=${1:?usage: check.sh <config> [--probe]}
PROBE=${2:-}
REPO=$(cd "$(dirname "$0")/../.." && pwd)
FAIL=0
ok() { printf 'ok    %s\n' "$*"; }
bad() { printf 'FAIL  %s\n' "$*"; FAIL=1; }
note() { printf 'note  %s\n' "$*"; }

NODE=$(node --version 2>/dev/null || echo none)
case "$NODE" in v24.*) ok "Node.js $NODE" ;; *) bad "Node.js 24 is required (found $NODE)" ;; esac

if docker info >/dev/null 2>&1; then
  ok "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null) reachable as $(id -un)"
  if docker info 2>&1 | grep -qi "no memory limit support"; then
    bad "Docker reports no memory limit support: enable the memory cgroup (setup.sh) and reboot"
  else
    ok "Docker memory limits are supported"
  fi
else
  bad "Docker is not reachable (is $(id -un) in the docker group? log in again after setup)"
fi

PAGE=$(getconf PAGESIZE)
if [ "$PAGE" = 4096 ]; then ok "page size 4K"; else note "page size $PAGE: if the toolchain probe fails, use the 4K kernel (kernel=kernel8.img in /boot/firmware/config.txt)"; fi

if [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" = yes ]; then ok "clock synchronized (NTP)"; else bad "clock not synchronized: check timedatectl"; fi

AVAIL=$(df -Pm "$REPO" | awk 'NR==2 {print $4}')
if [ "${AVAIL:-0}" -ge 10240 ]; then ok "free disk ${AVAIL} MiB"; else bad "less than 10 GiB free on the BoC disk"; fi
case "$(findmnt -no SOURCE --target "$REPO" 2>/dev/null)" in
  /dev/mmcblk*) note "BoC runs from the SD card; an SSD is recommended" ;;
  *) ok "BoC is not on the SD card" ;;
esac

if boc check-config "$CONFIG" >/dev/null 2>&1; then ok "config valid: $CONFIG"; else bad "config invalid or missing: $CONFIG"; fi
IMAGE=$(node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(c.sandbox?.image??"")' "$CONFIG" 2>/dev/null)
if [ -n "$IMAGE" ] && docker image inspect "$IMAGE" >/dev/null 2>&1; then ok "solver image present: $IMAGE"; else bad "solver image missing (push-image.sh)"; fi

# Credential files: existence and owner-only mode only; contents are never read here.
for f in $(node -e '
  const p=require("path"),c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")),d=p.dirname(p.resolve(process.argv[1]));
  const files=[c.aoc?.sessionCookieFile,...(c.subscriptions??[]).map(s=>s.credentialFile),c.alerts?.ntfy?.topicUrlFile,c.alerts?.ntfy?.tokenFile,c.alerts?.healthchecks?.pingUrlFile];
  console.log(files.filter(Boolean).map(f=>p.resolve(d,f)).join("\n"))' "$CONFIG" 2>/dev/null); do
  if [ -f "$f" ] && [ "$(stat -c %a "$f")" = 600 ] && [ "$(stat -c %U "$f")" = "$(id -un)" ]; then ok "private file $(basename "$f")"; else bad "private file missing or not 0600/owned: $f"; fi
done

if systemctl is-enabled boc >/dev/null 2>&1; then note "boc.service is enabled"; else note "boc.service is not enabled yet"; fi

if [ "$PROBE" = --probe ] && [ -n "$IMAGE" ]; then
  if (cd "$REPO" && npm run -s test:executor -- "$IMAGE" --toolchains); then
    ok "executor probe with toolchains"
  else
    bad "executor probe failed"
  fi
fi

if [ "$FAIL" = 0 ]; then echo "All checks passed."; else echo "Some checks failed."; fi
exit "$FAIL"
