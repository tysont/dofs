#!/bin/bash
# ABOUTME: Cross-compiles the agentfs binary from the fork for linux/amd64.
# ABOUTME: Places the binary at container/bin/agentfs for the Docker build.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONTAINER_DIR="$(dirname "$SCRIPT_DIR")"
AGENTFS_DIR="$(cd "$CONTAINER_DIR/../../agentfs" && pwd)"

if [ ! -d "$AGENTFS_DIR/cli" ]; then
    echo "Error: agentfs fork not found at $AGENTFS_DIR"
    echo "Expected: ../agentfs relative to the dofs repo root"
    exit 1
fi

echo "Building agentfs CLI from $AGENTFS_DIR..."

docker run --rm \
    --platform linux/amd64 \
    -v "$AGENTFS_DIR":/src \
    -v cargo-cache:/usr/local/cargo/registry \
    -w /src/cli \
    rust:1.83-slim \
    bash -c "apt-get update -qq && apt-get install -y -qq pkg-config libssl-dev cmake build-essential liblzma-dev >/dev/null 2>&1 && cargo build --release --no-default-features"

mkdir -p "$CONTAINER_DIR/bin"
cp "$AGENTFS_DIR/cli/target/release/agentfs" "$CONTAINER_DIR/bin/agentfs"
echo "Built: $CONTAINER_DIR/bin/agentfs"
