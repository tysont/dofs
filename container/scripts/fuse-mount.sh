#!/bin/bash
# ABOUTME: Starts bridge, mounts FUSE via AgentFS, and runs the command server.
# ABOUTME: Bridge relays Hrana between DO TCP and the FUSE daemon's libsql remote connection.

set -e

MOUNT_POINT="/volume"
BRIDGE_WS_URL="ws://localhost:8080"

# -- 1. Start bridge (TCP :9000 ↔ WS :8080) --
echo "Starting bridge..."
node /app/dist/bridge.js &
BRIDGE_PID=$!

# Wait for bridge TCP port to be listening
echo "Waiting for bridge on port 9000..."
for i in $(seq 1 30); do
  if bash -c 'echo >/dev/tcp/localhost/9000' 2>/dev/null; then
    echo "Bridge ready on port 9000"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "ERROR: Bridge did not start on port 9000"
    exit 1
  fi
  sleep 1
done

# -- 2. Mount FUSE via agentfs --
echo "Creating mount point..."
mkdir -p "$MOUNT_POINT"

echo "Mounting AgentFS at $MOUNT_POINT via $BRIDGE_WS_URL..."
agentfs mount \
    --remote-url "$BRIDGE_WS_URL" \
    --auth-token "" \
    --foreground \
    volume "$MOUNT_POINT" &
FUSE_PID=$!

# Wait for FUSE mount to be ready
echo "Waiting for FUSE mount..."
for i in $(seq 1 30); do
  if mountpoint -q "$MOUNT_POINT" 2>/dev/null; then
    echo "FUSE mounted at $MOUNT_POINT"
    break
  fi
  if ! kill -0 $FUSE_PID 2>/dev/null; then
    echo "ERROR: agentfs mount process exited"
    exit 1
  fi
  if [ "$i" -eq 30 ]; then
    echo "WARNING: FUSE mount readiness check timed out, proceeding anyway"
  fi
  sleep 1
done

# -- 3. Start command server --
echo "Starting command server..."
node /app/dist/command-server.js &
CMD_PID=$!

echo "All services running (bridge=$BRIDGE_PID, fuse=$FUSE_PID, cmd=$CMD_PID)"

# Wait for any child to exit
wait $BRIDGE_PID $FUSE_PID $CMD_PID
