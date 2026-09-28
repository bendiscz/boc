#!/bin/sh
# Native-Linux executor probe from any Docker host (including Docker Desktop for
# macOS). It starts a private Docker-in-Docker daemon whose bind mounts use a Linux
# filesystem, loads the solver image into it, and runs the executor probe with the
# toolchains as an ordinary user (UID 1000), under umask 022 and 077. Everything it
# creates is removed afterwards. Synthetic data only; no credentials are involved.
#
# Usage: sandbox/linux-probe.sh <local solver image ID sha256:...>
set -eu

IMAGE="${1:-}"
case "$IMAGE" in
  sha256:*) ;;
  *) echo "Supply the local solver image ID (sha256:...)." >&2; exit 2 ;;
esac
DIND=docker:dind@sha256:3f3c01aaaebf7cce837356b688b7c059a4749f10bd7660dec7c58fc454a283f0
NODE=node:24-trixie-slim@sha256:ebada56d5c601bd80f2af1cc3d101b1b730027d2395ab6d15402a2a5a83e4b51
NAME=boc-linux-probe-$$
REPO=$(cd "$(dirname "$0")/.." && pwd)

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm "$NAME" >/dev/null 2>&1 || true
  docker network rm "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker network create --internal "$NAME" >/dev/null
docker volume create "$NAME" >/dev/null
# The daemon's API is reachable only on this internal network, never published.
docker run -d --privileged --name "$NAME" --network "$NAME" -e DOCKER_TLS_CERTDIR= \
  -v "$NAME":/probe "$DIND" dockerd --host=tcp://0.0.0.0:2375 --host=unix:///var/run/docker.sock >/dev/null
i=0
until docker exec "$NAME" docker version >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -lt 60 ] || { echo "Inner daemon did not start." >&2; exit 1; }
  sleep 1
done
docker save "$IMAGE" | docker exec -i "$NAME" docker load -q >/dev/null
LOADED=$(docker exec "$NAME" docker image inspect "$IMAGE" --format '{{.Id}}')
[ "$LOADED" = "$IMAGE" ] || { echo "Image ID changed on load." >&2; exit 1; }
docker exec "$NAME" sh -c 'mkdir -p /probe/bin /probe/tmp && cp /usr/local/bin/docker /probe/bin/ && chown 1000:1000 /probe/tmp'
echo "Inner daemon: $(docker exec "$NAME" docker version --format '{{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}'), probe filesystem: $(docker exec "$NAME" stat -f -c %T /probe)"

for mask in 022 077; do
  echo "== umask $mask"
  docker run --rm --network "$NAME" --user 1000:1000 \
    -e HOME=/probe/tmp -e TMPDIR=/probe/tmp -e DOCKER_HOST="tcp://$NAME:2375" \
    -e PATH=/probe/bin:/usr/local/bin:/usr/bin:/bin \
    -v "$NAME":/probe -v "$REPO":/boc:ro -w /boc "$NODE" \
    sh -c "umask $mask; node test/sandbox-executor.ts $IMAGE --toolchains"
done
echo "Linux probe passed."
