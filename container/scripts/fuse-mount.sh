#!/bin/sh
# ABOUTME: Starts bridge, mounts FUSE via AgentFS, and runs the command server.
# ABOUTME: Bridge relays Hrana pipeline between DO TCP and the FUSE daemon.

MOUNT_POINT="/volume"

mkdir -p "$MOUNT_POINT"

# -- 1. Start bridge (TCP :9000 + HTTP :8080) --
echo "Starting bridge..."
node /app/dist/bridge.js &
BRIDGE_PID=$!

# Wait for bridge HTTP
echo "Waiting for bridge on :8080..."
i=0
while [ "$i" -lt 15 ]; do
  if node -e "fetch('http://localhost:8080/').then(() => process.exit(0)).catch(() => process.exit(1))" 2>/dev/null; then
    echo "Bridge ready"
    break
  fi
  i=$((i + 1))
  sleep 1
done

# -- 2. Mount FUSE via agentfs --
echo "Mounting AgentFS at $MOUNT_POINT via http://localhost:8080..."
agentfs mount \
    --remote-url http://localhost:8080 \
    --auth-token "" \
    --foreground \
    volume "$MOUNT_POINT" 2>&1 &
FUSE_PID=$!

# Wait for FUSE mount
echo "Waiting for FUSE mount..."
i=0
while [ "$i" -lt 30 ]; do
  if mountpoint -q "$MOUNT_POINT" 2>/dev/null; then
    echo "FUSE mounted at $MOUNT_POINT"
    break
  fi
  # Check if agentfs is still running
  if ! kill -0 $FUSE_PID 2>/dev/null; then
    echo "WARNING: agentfs mount process exited"
    break
  fi
  i=$((i + 1))
  sleep 1
done

# -- 3. Start command server --
echo "Starting command server with cwd=$MOUNT_POINT..."
DOFS_CWD="$MOUNT_POINT" node /app/dist/command-server.js &
CMD_PID=$!

echo "All services started (bridge=$BRIDGE_PID, fuse=$FUSE_PID, cmd=$CMD_PID)"
wait
