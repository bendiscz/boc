#!/bin/sh
# One-time setup of a dedicated Raspberry Pi 5 running Raspberry Pi OS Lite (64-bit)
# as the unattended BoC host (docs/RPI.md). Run as root on a fresh install:
#
#   sudo sh setup.sh
#
# Idempotent: rerunning updates the pieces it installed. It never reads, prints, or
# copies credentials, and it does not enable the BoC service (see the next steps
# printed at the end). Environment overrides:
#
#   BOC_REPO      git URL to clone          (default https://github.com/bendiscz/boc.git)
#   BOC_HOME      home of the boc user      (default /home/boc)
#   BOC_CONFIG    config path for the unit  (default $BOC_HOME/boc/var/event-2026.config.json)
#   NODE_VERSION  Node.js 24 release        (default 24.21.0)
#   BOC_FIREWALL  1 to install ufw with SSH-only inbound (default 1)
set -eu

BOC_REPO=${BOC_REPO:-https://github.com/bendiscz/boc.git}
BOC_HOME=${BOC_HOME:-/home/boc}
BOC_CONFIG=${BOC_CONFIG:-$BOC_HOME/boc/var/event-2026.config.json}
NODE_VERSION=${NODE_VERSION:-24.21.0}
BOC_FIREWALL=${BOC_FIREWALL:-1}
HERE=$(cd "$(dirname "$0")" && pwd)

say() { printf '\n==> %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }

[ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo sh setup.sh)." >&2; exit 2; }
[ "$(uname -m)" = aarch64 ] || { echo "Expected a 64-bit ARM OS (aarch64)." >&2; exit 2; }
# shellcheck disable=SC1091
. /etc/os-release
[ "${ID:-}" = debian ] || [ "${ID_LIKE:-}" = debian ] || { echo "Expected Raspberry Pi OS or Debian." >&2; exit 2; }
CODENAME=${VERSION_CODENAME:?}

say "System update"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get -y -q full-upgrade
apt-get -y -q install ca-certificates curl git gnupg xz-utils unattended-upgrades

say "Clock: NTP synchronization, and a unit that waits for it"
timedatectl set-ntp true
systemctl enable systemd-time-wait-sync.service >/dev/null 2>&1 || warn "systemd-time-wait-sync is not available."

say "Security updates only, never an automatic reboot"
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
cat >/etc/apt/apt.conf.d/52boc-unattended <<'EOF'
// BoC host (docs/RPI.md): the event must not be interrupted by a reboot.
Unattended-Upgrade::Automatic-Reboot "false";
EOF

say "Docker Engine from Docker's Debian repository"
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=arm64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $CODENAME stable" \
  >/etc/apt/sources.list.d/docker.list
apt-get update -q
apt-get -y -q install docker-ce docker-ce-cli containerd.io
# Solver containers run with --rm; bound the daemon's own logs anyway.
[ -f /etc/docker/daemon.json ] || echo '{ "log-driver": "local" }' >/etc/docker/daemon.json
systemctl enable --now docker >/dev/null

say "Node.js $NODE_VERSION (official arm64 build, checked against SHASUMS256.txt)"
if [ "$(/usr/local/bin/node --version 2>/dev/null || true)" != "v$NODE_VERSION" ]; then
  TMP=$(mktemp -d)
  TARBALL="node-v$NODE_VERSION-linux-arm64.tar.xz"
  curl -fsSLo "$TMP/$TARBALL" "https://nodejs.org/dist/v$NODE_VERSION/$TARBALL"
  curl -fsSLo "$TMP/SHASUMS256.txt" "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
  (cd "$TMP" && grep " $TARBALL\$" SHASUMS256.txt | sha256sum -c -)
  tar -xJf "$TMP/$TARBALL" -C /usr/local --strip-components=1 --no-same-owner
  rm -rf "$TMP"
fi
/usr/local/bin/node --version

say "The boc user (member of the docker group, which is root-equivalent)"
id boc >/dev/null 2>&1 || useradd --create-home --home-dir "$BOC_HOME" --shell /bin/bash boc
usermod -aG docker boc
chmod 0700 "$BOC_HOME"
# SSH access for the operator's transfers (push-image.sh, push-private.sh).
# Skipped when the admin account is boc itself (the installer then created it).
if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != boc ] && [ -f "/home/$SUDO_USER/.ssh/authorized_keys" ]; then
  install -d -m 0700 -o boc -g boc "$BOC_HOME/.ssh"
  install -m 0600 -o boc -g boc "/home/$SUDO_USER/.ssh/authorized_keys" "$BOC_HOME/.ssh/authorized_keys"
fi

say "BoC checkout and build"
if [ ! -d "$BOC_HOME/boc/.git" ]; then
  runuser -u boc -- git clone -q "$BOC_REPO" "$BOC_HOME/boc"
else
  runuser -u boc -- git -C "$BOC_HOME/boc" pull -q --ff-only || warn "git pull failed; keeping the current checkout."
fi
runuser -u boc -- sh -c "cd '$BOC_HOME/boc' && PATH=/usr/local/bin:\$PATH npm ci --ignore-scripts --no-audit --no-fund -q && PATH=/usr/local/bin:\$PATH npm run -s build"
runuser -u boc -- install -d -m 0700 "$BOC_HOME/boc/.secrets" "$BOC_HOME/boc/var"
cat >/usr/local/bin/boc <<EOF
#!/bin/sh
exec /usr/local/bin/node $BOC_HOME/boc/dist/main.js "\$@"
EOF
chmod 0755 /usr/local/bin/boc

say "systemd unit (installed, not enabled)"
sed -e "s|@BOC_HOME@|$BOC_HOME|g" -e "s|@BOC_CONFIG@|$BOC_CONFIG|g" "$HERE/boc.service" \
  >/etc/systemd/system/boc.service
systemctl daemon-reload

if [ "$BOC_FIREWALL" = 1 ]; then
  say "Firewall: SSH only inbound (BoC needs no inbound connections)"
  apt-get -y -q install ufw
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  ufw allow OpenSSH >/dev/null
  ufw --force enable >/dev/null
fi

say "Kernel: the memory cgroup (solver memory limits)"
CMDLINE=/boot/firmware/cmdline.txt
if grep -qw memory /sys/fs/cgroup/cgroup.controllers 2>/dev/null; then
  echo "Memory cgroup is available."
elif [ -f "$CMDLINE" ]; then
  if ! grep -q "cgroup_enable=memory" "$CMDLINE"; then
    cp "$CMDLINE" "$CMDLINE.boc-backup"
    sed -i '1 s/$/ cgroup_enable=memory/' "$CMDLINE"
  fi
  warn "The memory cgroup is off: added cgroup_enable=memory to $CMDLINE. Reboot, then run check.sh."
else
  warn "The memory cgroup is off and $CMDLINE was not found: solver memory limits would not apply."
fi

say "Done. Next steps (docs/RPI.md):"
cat <<EOF
  1. Reboot if a kernel change was reported above.
  2. From the development machine: deploy/rpi/push-image.sh boc@<pi> <image-id>
     and deploy/rpi/push-private.sh boc@<pi> (credentials and the event config).
     Never run BoC on the development machine with the same credential files again.
  3. On the Pi, as boc: sh ~/boc/deploy/rpi/check.sh $BOC_CONFIG
  4. sudo systemctl enable --now boc; follow it with: journalctl -u boc -f
EOF
