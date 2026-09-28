# BoC solver toolchain image (D010). Build by the operator on a trusted host; the
# resulting local image ID (sha256:...) is what BoC runs. Nothing here is fetched
# at solve time: containers run with --network=none.
#
# Integrity: the base is pinned by digest; Debian packages are verified by apt's
# signed repositories; uv is installed from PyPI only if its wheel matches a hash in
# uv-requirements.txt (pip --require-hashes; see docs/SANDBOX.md).
ARG BASE=node:24-trixie-slim@sha256:ebada56d5c601bd80f2af1cc3d101b1b730027d2395ab6d15402a2a5a83e4b51
FROM ${BASE}

# Debian packages come over apt's signed (HTTP) repositories. The optional
# build-only CA bundle for TLS-intercepting networks (BuildKit secret "extra_ca")
# is combined with the system bundle in /tmp for the PyPI step only and is not
# stored in any image layer.
RUN --mount=type=secret,id=extra_ca,required=false \
    --mount=type=bind,source=uv-requirements.txt,target=/tmp/boc-uv-requirements.txt \
    set -eu; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      ca-certificates python3 python3-pip python3-venv \
      python3-numpy python3-scipy python3-sympy python3-networkx \
      golang-go rustc cargo build-essential; \
    CA=/etc/ssl/certs/ca-certificates.crt; \
    if [ -s /run/secrets/extra_ca ]; then \
      CA=/tmp/boc-build-ca.pem; \
      cat /etc/ssl/certs/ca-certificates.crt /run/secrets/extra_ca > "$CA"; \
    fi; \
    PIP_CERT="$CA" SSL_CERT_FILE="$CA" \
      python3 -m pip install --no-cache-dir --break-system-packages \
        --require-hashes --only-binary=:all: --no-deps -r /tmp/boc-uv-requirements.txt; \
    rm -f /tmp/boc-build-ca.pem; \
    apt-get purge -y python3-pip; \
    apt-get autoremove -y; \
    rm -rf /var/lib/apt/lists/* /root/.cache

# Tool versions are recorded in the image for artifacts and reports.
RUN { python3 --version; uv --version; node --version; go version; rustc --version; cargo --version; } \
      > /etc/boc-toolchain-versions 2>&1

USER 65534:65534
WORKDIR /work
