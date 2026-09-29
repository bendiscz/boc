#!/bin/sh
# Copy the tested solver image to the BoC host (docs/RPI.md). Run on the
# development machine:
#
#   deploy/rpi/push-image.sh boc@<pi> sha256:<image-id>
#
# `docker save | docker load` keeps the image ID, so `sandbox.image` in the config
# stays valid and the host runs exactly the image that passed the probes.
set -eu
HOST=${1:?usage: push-image.sh <ssh-host> <sha256:image-id>}
IMAGE=${2:?usage: push-image.sh <ssh-host> <sha256:image-id>}
case "$IMAGE" in sha256:*) ;; *) echo "Supply the image ID (sha256:...)." >&2; exit 2 ;; esac
docker image inspect "$IMAGE" >/dev/null
docker save "$IMAGE" | ssh "$HOST" docker load -q >/dev/null
LOADED=$(ssh "$HOST" docker image inspect "$IMAGE" --format '{{.Id}}')
[ "$LOADED" = "$IMAGE" ] || { echo "Image ID differs on the host: $LOADED" >&2; exit 1; }
echo "Loaded $IMAGE on $HOST."
