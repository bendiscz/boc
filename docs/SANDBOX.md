# Solver sandbox

Generated code runs only through `src/sandbox/executor.ts` (D010). Each command starts a fresh container with these restrictions:

- `--network=none`, a read-only root filesystem, `--cap-drop=ALL`, `no-new-privileges`, UID/GID 65534, and `--ipc=none`.
- Memory 2 GiB with no swap, 2 CPUs, and a limit of 256 PIDs.
- The per-attempt workspace is bind-mounted **read-only** at `/work`. A bounded, exec-enabled tmpfs is mounted at `/tmp` for build output and scratch files.
- A fixed environment with no host variables, credentials, or Docker socket. The Docker CLI itself receives only `PATH`, `HOME`, `DOCKER_HOST`, `DOCKER_CONTEXT`, `DOCKER_CONFIG`, and `TMPDIR`.
- Only digest-pinned images, and never a pull (`--pull=never`).
- A timeout or abort signal that kills the container, not just the CLI. Output is bounded and terminal control characters are neutralized.

Only trusted host tools write to the workspace (`src/sandbox/workspace.ts`): they accept relative paths only, never follow symlinks, and enforce size and count limits. Because the container sees the workspace read-only, generated code cannot plant symlinks for the host to follow. The attempt directory is `0755` so that the container's unprivileged UID can read it on Linux. Confidentiality comes from the private `0700` storage directories above it.

## Toolchain image

`sandbox/Dockerfile` builds Python 3 with `uv` and preinstalled numpy, scipy, sympy, and networkx, plus Node.js 24, Go, and Rust/Cargo. The base image is `node:24-trixie-slim`, pinned by digest, and the other tools come from Debian's signed repositories. `uv` comes from PyPI and is hash-pinned: `sandbox/uv-requirements.txt` lists the exact version and the sha256 of each accepted wheel, and pip installs it with `--require-hashes --only-binary=:all: --no-deps`, so a wheel that does not match is refused. uv has no Python dependencies. Libraries are acquired only at image build time; solve-time containers have no network, so `uv`, `go`, and `cargo` must work offline (`UV_OFFLINE`, `GOPROXY=off`, `CARGO_NET_OFFLINE`). Adding libraries means rebuilding the image, which is the controlled dependency-acquisition path.

Build on a trusted host:

```sh
docker build -t boc-solver:dev sandbox
docker image inspect boc-solver:dev --format '{{.Id}}'   # put this sha256:... in config sandbox.image
```

**TLS-intercepting networks.** If a corporate proxy intercepts HTTPS, pass its CA bundle as a BuildKit secret, not as a build argument or a copied file:

```sh
docker build --secret id=extra_ca,src=/path/to/corporate-ca.pem -t boc-solver:dev sandbox
```

The bundle is combined with the system bundle in `/tmp` for the PyPI step only, then deleted. It is not stored in any image layer. Do not commit CA bundles or machine-specific paths.

**Upgrading uv.** Edit `sandbox/uv-requirements.txt`: set the new version, and replace every hash with the sha256 values from `https://pypi.org/pypi/uv/<version>/json` for the glibc Linux wheels (`manylinux…x86_64` and `manylinux…aarch64`). Rebuild, run the executor probe with `--toolchains`, and update `sandbox.image` in each config. The hashes are only as trustworthy as PyPI's metadata at fetch time. To check them, compare against a wheel downloaded separately (`shasum -a 256`).

**Linux, verified 2026-09-28.** `npm run test:linux` against the new image (Docker 29.8.1 linux/arm64, inner daemon on ext4) passed under umask 022. Under umask 077 it first **failed**: workspace files were created `0600`, so the container's UID 65534 could not read them. Docker Desktop's file sharing had hidden this. The workspace now sets `0644`/`0755` explicitly with `fchmod`/`chmod`; the parents stay `0700`. With that fix, both umasks pass, and an offline regression test covers umask 077.

**Verified 2026-09-28** (Docker Desktop, arm64). A build with the pinned `uv-requirements.txt` selected `uv-0.8.22-py3-none-manylinux_2_28_aarch64.whl`, whose downloaded sha256 matched the pin. As a negative control, pip in the image refused the same wheel against an altered hash (`--require-hashes`, offline). The image history, `/tmp`, and the system trust store contain none of the build CA's certificates. `npm run test:executor -- <id> --toolchains` passed.

## Verification

- `npm run test:executor -- <image-id>` is the opt-in probe of the production executor. It checks that the container runs non-root, with no host variables, a read-only `/work`, a writable `/tmp`, no external network interface, bounded output, and timeout and abort each killing and removing the container. With `--toolchains`, it also runs Python with numpy, scipy, sympy and networkx, `uv`, Node.js, Go, rustc, and Cargo (from a copy of the project in `/tmp`). It is not part of `npm test` or CI.
- `npm run test:sandbox -- <image-id>` is the original isolation probe.
- `npm run test:linux -- <image-id>` runs the executor probe (with `--toolchains`) against a native Linux Docker daemon from any Docker host. It starts a digest-pinned `docker:dind` container whose API is reachable only on an internal network, and loads the solver image into it; the image ID is unchanged. It then runs the probe as UID 1000 on an ext4 volume, under umask `022` and `077`, and removes everything afterwards. Docker Desktop's macOS file sharing hides Linux permission semantics; this probe does not.

## Outstanding

- A snapshot-pinned Debian mirror for fully reproducible images. Debian packages are verified by apt's signatures, but their versions follow the current archive at build time.
- An amd64 run of the Linux probe: so far only arm64 (the `sandbox/linux-probe.sh` method works on any Docker host). A bare-metal Linux host run is still worthwhile before an event, but the native-Linux permission semantics are now covered. The Raspberry Pi host covers it: `deploy/rpi/check.sh --probe` (RPI.md).
- Seccomp/AppArmor profile review beyond Docker defaults, and a dedicated VM for a stronger threat model.
