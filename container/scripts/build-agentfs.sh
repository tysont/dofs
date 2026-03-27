#!/bin/bash
# ABOUTME: Cross-compiles the agentfs binary from the fork for linux/amd64.
# ABOUTME: Places the binary at container/bin/agentfs for inclusion in the Docker image.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONTAINER_DIR="$(dirname "$SCRIPT_DIR")"
AGENTFS_DIR="$(dirname "$CONTAINER_DIR")/../agentfs"

if [ ! -d "$AGENTFS_DIR/cli" ]; then
    echo "Error: agentfs fork not found at $AGENTFS_DIR"
    echo "Expected: ../agentfs relative to the dofs repo root"
    exit 1
fi

echo "Building agentfs CLI from $AGENTFS_DIR..."

# Build for linux/amd64 using Docker for cross-compilation
docker run --rm \
    -v "$AGENTFS_DIR":/src \
    -v cargo-cache:/usr/local/cargo/registry \
    -w /src/cli \
    rust:1.83-slim \
    bash -c "apt-get update && apt-get install -y pkg-config libssl-dev && cargo build --release"

mkdir -p "$CONTAINER_DIR/bin"
cp "$AGENTFS_DIR/cli/target/release/agentfs" "$CONTAINER_DIR/bin/agentfs"
echo "Built agentfs binary at container/bin/agentfs"
