# Unattended host: Raspberry Pi 5

This guide turns a Raspberry Pi 5 (8 GB) into a single-purpose BoC appliance (D027). It runs BoC, Docker, and nothing else. BoC runs as a systemd service, restarts itself after a failure, and reports through the ntfy alerts and the healthchecks.io dead-man's switch (D023). A dedicated host avoids what happened on the development Mac, where idle sleep paused a run (EVALUATION.md, 2026-09-29).

Files in `deploy/rpi/`:

| File | Runs on | Purpose |
| --- | --- | --- |
| `setup.sh` | Pi, as root | One-time host setup: updates, Docker Engine, Node.js 24, the `boc` user, a BoC build, the systemd unit, the firewall, and the memory cgroup |
| `boc.service` | Pi | systemd unit template, installed by `setup.sh` (not enabled) |
| `check.sh` | Pi, as `boc` | Pre-flight checks; `--probe` also runs the executor probe with the toolchains |
| `push-image.sh` | development machine | Copies the tested solver image to the Pi, keeping its ID |
| `push-private.sh` | development machine | Moves `.secrets/` and the event config to the Pi |

**Verification status.**
- Before any hardware: `setup.sh` ran end to end in a Debian trixie arm64 container, with only the host-level `systemctl`, `timedatectl`, and `ufw` calls stubbed. `boc.service` passes `systemd-analyze verify`, and all scripts pass shellcheck.
- **On the operator's Pi 5 (8 GB), 2026-09-29:** Raspberry Pi OS Lite trixie, kernel 6.18 `rpi-2712`, running from the SD card and on Ethernet.
  - The operator ran `setup.sh`. As expected (⚠ below), the stock kernel command line contained `cgroup_disable=memory`. The script appended `cgroup_enable=memory`, and after a reboot the memory controller was active.
  - `push-image.sh` took 79 s for 2.3 GB, and the image ID was unchanged.
  - `check.sh`: every check passed (the notes: 16K pages, SD card).
  - The executor probe with every toolchain passed on 16K pages in 20 s, so the 4K kernel is not needed.
  - A 3 GiB allocation under the 2 GiB limit was killed (exit 137).
  - A manual `boc run` of the event config passed the start check (both credentials refreshed, AoC session read). SIGTERM stopped it cleanly.
  - This smoke test found the >24.8-day timer bug, fixed in `ec5b3b5`.
  - Restart drills under systemd, 2026-09-30: `kill -9`, an outside SIGTERM, `sudo systemctl stop` (no restart), and `sudo reboot` all passed.
  - Replay benchmark: 12/12 parts on the first submission. The Pi is about 4.8× slower per core than the development Mac, and no program came near the 60-second run cap (EVALUATION.md).
- **In production since 2026-09-30, 12:27 CEST:** `boc.service` is enabled and running the event config.
  - Settings: `reasoning: "low"`, `assumedMaxOutputTokens: 32000`, `sandbox.maxRunSeconds: 240` (D031).
  - The checkout is at `main`; the build is from `9627aaa`, and later commits changed only docs.
  - Still to do: move from the SD card to an SSD before 1 December (step 1 of this guide), then `check.sh --probe` and a service restart.

## Hardware

- **Storage:** an **SSD**, either an NVMe drive on an M.2 HAT or a USB 3 SSD, and boot from it. Every BoC journal record is flushed to disk, and an SD card wears out and stalls. `check.sh` flags a system running from the SD card.
- **Cooling:** the official **active cooler**. Rust and Go builds in the solver containers otherwise throttle the CPU.
- **Power:** the official 27 W USB-C supply. A UPS HAT is optional, and power loss is safe anyway (D012, D024).
- **Network:** **Ethernet**. Wi-Fi is not needed and can be disabled.
- **Clock:** releases are timed by the system clock, which NTP synchronizes at boot. The optional RTC battery keeps the time across a power cut before the network comes up.

## 1. Operating system

1. In Raspberry Pi Imager, choose **Raspberry Pi OS Lite (64-bit)** and write it to the SSD. In the customization screen, set:
   - the hostname (for example `boc`);
   - an admin user with **your SSH public key**, and disable password login;
   - the locale and time zone.
2. Boot the Pi from the SSD and log in over SSH.
3. Clone the repository and run the setup:

   ```sh
   git clone https://github.com/bendiscz/boc.git && cd boc
   sudo sh deploy/rpi/setup.sh
   ```

`setup.sh` is idempotent, and rerunning it updates what it installed. It does the following:

- **Updates:** a full system upgrade, then unattended **security** updates only, with automatic reboots disabled (`/etc/apt/apt.conf.d/52boc-unattended`).
- **Clock:** enables NTP and `systemd-time-wait-sync`, so that the service starts only on a synchronized clock.
- **Docker Engine:** from Docker's Debian repository. The daemon log driver is `local`, and solver containers are removed after every run anyway.
- **Node.js:** the official Node.js 24 arm64 build in `/usr/local`, verified against the release's `SHASUMS256.txt`. The version is set by `NODE_VERSION`, default 24.21.0.
- **The `boc` user:** home directory mode `0700`, in the `docker` group. If you created `boc` as the admin account in Raspberry Pi Imager, the script reuses it. The service account then also has `sudo`, protected by a password; that isolates no less than membership in the `docker` group already does. Your `authorized_keys` is copied to it, so the push scripts can connect as `boc@<pi>`. Membership in the `docker` group is root-equivalent, which is one reason the Pi runs nothing else.
- **BoC itself:** a checkout in `~boc/boc`, built with `npm ci --ignore-scripts && npm run build`. A `boc` wrapper goes in `/usr/local/bin`.
- **Service:** `/etc/systemd/system/boc.service`, installed but not enabled.
- **Firewall:** `ufw` allowing only SSH inbound. BoC needs no inbound connections; set `BOC_FIREWALL=0` to skip this.
- **⚠ Memory cgroup:** the solver's 2 GiB memory limit needs the kernel's memory cgroup, which Raspberry Pi kernels have historically disabled. If it is missing, the script adds `cgroup_enable=memory` to `/boot/firmware/cmdline.txt`, keeping a backup, and asks for a reboot. Without it, a runaway solver could exhaust the Pi's memory.

Reboot if the script asked for it.

## 2. Solver image and private files

Run these on the **development machine**:

```sh
deploy/rpi/push-image.sh boc@<pi> sha256:<image-id>      # the ID in the event config's sandbox.image
deploy/rpi/push-private.sh boc@<pi>                       # .secrets/ and var/event-2026.config.json
```

- **Why copy rather than rebuild:** `docker save | docker load` keeps the image ID, so `sandbox.image` stays valid, and the Pi runs exactly the image that passed the probes.
  - Rebuilding on the Pi also works. Run `docker build -t boc-solver:dev sandbox` in `~boc/boc`, which needs no CA secret outside the corporate network. A rebuilt image gets a new ID: put it in the config and rerun the probe.
- **Moving the credentials:** `push-private.sh` sends the files inside SSH and keeps their owner-only modes. It never prints them.
  - **From then on, the Pi owns the credentials.** Refresh tokens can be single-use (D022), so never run BoC on the development machine with the same credential files again. Delete or rename them there.
  - Instead of moving the files, you can authorize on the Pi with `boc login var/event-2026.config.json <subscription>`.
    - Copilot's device code works over SSH.
    - For Codex, use `--browser`: open the printed URL on any machine, then paste the final redirect URL into the terminal.
    - The AoC cookie still has to be copied.

## 3. Checks on the Pi

As the `boc` user:

```sh
sh ~/boc/deploy/rpi/check.sh ~/boc/var/event-2026.config.json --probe
```

The script checks the following. It is offline, except that `--probe` runs synthetic containers, and it never reads credential contents.

- Node.js 24 is installed, Docker is reachable, and **Docker's memory limits are supported**.
- The clock is NTP-synchronized.
- There is at least 10 GiB free, on a disk other than the SD card.
- The config is valid, and the solver image is present.
- Every private file the config names exists with mode `0600` and belongs to `boc`.
- With `--probe`: the executor probe with every toolchain. This is also the **bare-metal Linux run** the sandbox verification still lacks (SANDBOX.md).

**⚠ Page size.** The Pi 5 kernel uses 16K memory pages, which `check.sh` reports. Some arm64 binaries assume 4K pages. If the toolchain probe fails, add `kernel=kernel8.img` to `/boot/firmware/config.txt` to use the 4K kernel, reboot, and probe again.

**Speed.** The Pi 5 is about 4.8× slower per core than the development Mac (EVALUATION.md, 2026-09-30), so the event config sets `"sandbox": { "maxRunSeconds": 240 }` (the default is 60) to keep the Mac's headroom. A short replay benchmark shows how programs fare on the Pi's CPU. It spends a few model credits; start it only with the operator's go-ahead:

```sh
cd ~/boc && boc replay var/<bench>.config.json --source var/<source>.config.json --days 1,2
```

The bench and source configs need their storage copied from the development machine. Otherwise, a 2025 copy of the event config with its own storage can run one past day through `boc run`, with the go-ahead.

## 4. Service

```sh
sudo systemctl enable --now boc
journalctl -u boc -f                          # the run log (also in var/event-2026/runs/2026/events.log)
boc status ~/boc/var/event-2026.config.json   # state and credits; safe while BoC runs
```

`boc.service` behaves as follows:

- **Start conditions:** it starts after the network, Docker, and a synchronized clock, and it starts again at boot.
- **Stopping:** `systemctl stop boc` sends SIGTERM, and BoC stops after the current step. If that takes longer than 120 s, systemd kills it. The journals stay consistent either way.
- **Restarts:** after a failure, systemd restarts BoC 60 s later. The restarted run removes stale locks by itself (D024) and resumes from the recorded state.
  - At most 5 starts per hour, so a persistent error cannot loop. The dead-man's switch then reports the stopped service.
  - A usage error (exit 2) is never retried.
  - Exit 0, meaning the event has no further puzzles, ends the service.
- **Hardening:** `NoNewPrivileges`, a private `/tmp`, a read-only `/usr`, `/boot`, and `/etc`, and `UMask=0077`. The Docker socket stays reachable through the `docker` group.

Maintenance while BoC runs: stop the service before any command that changes state (`boc ledger …`, `boc submission …`), then start it again.

Updating BoC:

```sh
sudo systemctl stop boc
cd ~boc/boc && sudo -u boc git pull --ff-only && sudo -u boc npm ci --ignore-scripts && sudo -u boc npm run build
sudo systemctl start boc
```

## Before the event

- Apply system updates and reboot **before** 1 December. Automatic reboots are off, and security updates keep installing.
- Recheck the AoC rules and the provider terms (milestone 7 in PLAN.md).
- Rehearse on the Pi: `check.sh --probe`, then a replay or one past day with the go-ahead.
- Set the healthchecks.io schedule to the published calendar (OPERATOR.md, "Alerts").
- Run `boc alert-test`, and check that a push arrives on your phone.
