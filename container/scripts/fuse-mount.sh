#!/bin/bash
# ABOUTME: Starts bridge, mounts FUSE via AgentFS, and runs the command server.
# ABOUTME: Bridge relays Hrana between DO TCP and the FUSE daemon's libsql remote connection.

set -e

MOUNT_POINT="/volume"
BRIDGE_WS_URL="ws://localhost:8080"

mkdir -p "$MOUNT_POINT"

# -- 1. Start bridge (TCP :9000 ↔ HTTP+WS :8080) --
echo "Starting bridge..."
node /app/dist/bridge.js &
BRIDGE_PID=$!

# Wait for bridge WS port
for i in $(seq 1 15); do
  if curl -sf http://localhost:8080/ >/dev/null 2>&1; then
    echo "Bridge ready"
    break
  fi
  sleep 1
done

# -- 2. Start command server immediately (don't wait for FUSE) --
echo "Starting command server..."
node /app/dist/command-server.js &
CMD_PID=$!

# -- 3. Mount FUSE via agentfs (may take time, runs in background) --
echo "Mounting AgentFS at $MOUNT_POINT via $BRIDGE_WS_URL..."
agentfs mount \
    --remote-url "$BRIDGE_WS_URL" \
    --auth-token "" \
    --foreground \
    volume "$MOUNT_POINT" 2>&1 &
FUSE_PID=$!

echo "All services started (bridge=$BRIDGE_PID, cmd=$CMD_PID, fuse=$FUSE_PID)"

# Wait for any child to exit
wait $BRIDGE_PID $FUSE_PID $CMD_PID
