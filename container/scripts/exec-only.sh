#!/bin/bash
# ABOUTME: Starts bridge + command server without FUSE mount.
# ABOUTME: Used for testing exec against a non-FUSE working directory.

set -e

WORK_DIR="/volume"
mkdir -p "$WORK_DIR"

echo "Starting bridge in background..."
node /app/dist/bridge.js &

sleep 1

echo "Starting command server..."
exec node /app/dist/command-server.js
