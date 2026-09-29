#!/bin/sh
# Move the private runtime files to the BoC host (docs/RPI.md): `.secrets/` and the
# event config. Run on the development machine:
#
#   deploy/rpi/push-private.sh boc@<pi> [var/event-2026.config.json]
#
# The files travel inside SSH and keep their owner-only modes; nothing is printed.
# Afterwards the host owns the credentials: refresh tokens can be single-use
# (D022), so never run BoC on this machine with the same credential files again.
set -eu
HOST=${1:?usage: push-private.sh <ssh-host> [config]}
CONFIG=${2:-var/event-2026.config.json}
REPO=$(cd "$(dirname "$0")/../.." && pwd)
[ -d "$REPO/.secrets" ] && [ -f "$REPO/$CONFIG" ] || { echo "Missing .secrets/ or $CONFIG." >&2; exit 2; }
# COPYFILE_DISABLE: no macOS metadata files in the archive.
COPYFILE_DISABLE=1 tar -C "$REPO" -cf - .secrets "$CONFIG" |
  ssh "$HOST" 'umask 077 && mkdir -p ~/boc && tar -C ~/boc -xf - && chmod 700 ~/boc/.secrets && chmod 600 ~/boc/.secrets/*'
echo "Copied .secrets/ and $CONFIG to $HOST. Do not run BoC here with these credentials again."
