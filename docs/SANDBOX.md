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

`sandbox/Dockerfile` builds Python 3 with `uv` and preinstalled numpy, scipy, sympy, and networkx, plus Node.js 24, Go, and Rust/Cargo. The base image is `node:24-trixie-slim`, pinned by digest, and the other tools come from Debian's signed repositories. `uv` is pinned by version from PyPI. Libraries are acquired only at image build time; solve-time containers have no network, so `uv`, `go`, and `cargo` must work offline (`UV_OFFLINE`, `GOPROXY=off`, `CARGO_NET_OFFLINE`). Adding libraries means rebuilding the image, which is the controlled dependency-acquisition path.

Build on a trusted host:

```sh
docker build --build-arg UV_VERSION=<pinned> -t boc-solver:dev sandbox
docker image inspect boc-solver:dev --format '{{.Id}}'   # put this sha256:... in config sandbox.image
```

**TLS-intercepting networks.** If a corporate proxy intercepts HTTPS, pass its CA bundle as a BuildKit secret, not as a build argument or a copied file:

```sh
docker build --secret id=extra_ca,src=/path/to/corporate-ca.pem --build-arg UV_VERSION=<pinned> -t boc-solver:dev sandbox
```

The bundle is combined with the system bundle in `/tmp` for the PyPI step only, then deleted. It is not stored in any image layer. Do not commit CA bundles or machine-specific paths.

## Verification

- `npm run test:executor -- <image-id>` is the opt-in probe of the production executor. It checks that the container runs non-root, with no host variables, a read-only `/work`, a writable `/tmp`, no external network interface, bounded output, and timeout and abort each killing and removing the container. With `--toolchains`, it also runs Python with numpy, scipy, sympy and networkx, `uv`, Node.js, Go, rustc, and Cargo (from a copy of the project in `/tmp`). It is not part of `npm test` or CI.
- `npm run test:sandbox -- <image-id>` is the original isolation probe.

## Outstanding

- Hash-pinned (`--require-hashes`) acquisition of `uv` and any PyPI packages. A snapshot-pinned Debian mirror for fully reproducible images.
- A Linux host run of the executor probe. So far it has run only on Docker Desktop for macOS, where bind-mount permissions behave differently.
- Seccomp/AppArmor profile review beyond Docker defaults, and a dedicated VM for a stronger threat model.
