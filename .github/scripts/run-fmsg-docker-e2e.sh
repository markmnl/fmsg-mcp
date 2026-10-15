#!/usr/bin/env bash
# Run the fmsg-mcp end-to-end suite against two real fmsg stacks provisioned by
# fmsg-docker's integration runner (sourced so its exported URLs/keys are visible).
set -euo pipefail

# Named distinctly: run-tests.sh (sourced below) defines its own REPO_ROOT.
FMSG_MCP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FMSG_DOCKER_REPO="${FMSG_DOCKER_REPO:-https://github.com/markmnl/fmsg-docker.git}"
FMSG_DOCKER_REF="${FMSG_DOCKER_REF:-main}"
FMSG_DOCKER_DIR="$(mktemp -d)"

# podman-compose cannot read fmsg-docker's test compose override
# (containers/podman-compose#1562); fmsg-docker's podman runner works around it.
FMSG_DOCKER_RUNNER=run-tests.sh
if docker --version 2>/dev/null | grep -qi podman; then
  FMSG_DOCKER_RUNNER=run-tests-podman.sh
fi

cleanup() {
  if [ -f "$FMSG_DOCKER_DIR/test/$FMSG_DOCKER_RUNNER" ]; then
    bash "$FMSG_DOCKER_DIR/test/$FMSG_DOCKER_RUNNER" cleanup || true
  fi
  rm -rf "$FMSG_DOCKER_DIR" "${FMSG_PODMAN_SHIM_DIR:-}"
}
trap cleanup EXIT

git clone --no-checkout --filter=blob:none "$FMSG_DOCKER_REPO" "$FMSG_DOCKER_DIR"
git -C "$FMSG_DOCKER_DIR" checkout "$FMSG_DOCKER_REF"

if [ "$FMSG_DOCKER_RUNNER" = run-tests-podman.sh ] && ! grep -q FMSG_PODMAN_SHIM_DIR "$FMSG_DOCKER_DIR/test/$FMSG_DOCKER_RUNNER"; then
  echo "fmsg-docker $FMSG_DOCKER_REF's podman runner cannot be sourced; use a newer FMSG_DOCKER_REF" >&2
  exit 1
fi

# shellcheck source=/dev/null
source "$FMSG_DOCKER_DIR/test/$FMSG_DOCKER_RUNNER"
# The runner installs an ERR trap that dumps compose logs; our suite reports its own failures.
trap - ERR

cd "$FMSG_MCP_ROOT"
FMSG_E2E=1 \
FMSG_E2E_ALICE_API_URL="$HAIRPIN_API_URL" \
FMSG_E2E_ALICE_API_KEY="$ALICE_API_KEY" \
FMSG_E2E_ALICE_ADDR="$ALICE_ADDR" \
FMSG_E2E_BOB_API_URL="$EXAMPLE_API_URL" \
FMSG_E2E_BOB_API_KEY="$BOB_API_KEY" \
FMSG_E2E_BOB_ADDR="$BOB_ADDR" \
FMSG_E2E_CAROL_API_KEY="$CAROL_API_KEY" \
FMSG_E2E_CAROL_ADDR="$CAROL_ADDR" \
  npm run test:e2e
