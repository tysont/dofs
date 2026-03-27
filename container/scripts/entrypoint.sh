#!/bin/bash
# ABOUTME: Container entrypoint that starts the TCP↔WS bridge.
# ABOUTME: Additional services (FUSE mount, command server) will be added in later steps.

set -e

echo "Starting bridge..."
exec node /app/dist/bridge.js
