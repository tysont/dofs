#!/bin/bash
# ABOUTME: Starts the bridge, mounts AgentFS via FUSE, and runs the command server.
# ABOUTME: Bridge relays Hrana between DO TCP and AgentFS's libsql remote connection.

set -e

MOUNT_POINT="/agent"
BRIDGE_WS_URL="ws://localhost:8080"

echo "Starting bridge in background..."
node /app/dist/bridge.js &
BRIDGE_PID=$!

# Wait for bridge to start listening
sleep 2

echo "Creating mount point..."
mkdir -p "$MOUNT_POINT"

echo "Mounting AgentFS at $MOUNT_POINT via $BRIDGE_WS_URL..."
agentfs mount \
    --remote-url "$BRIDGE_WS_URL" \
    --auth-token "" \
    --foreground \
    agent "$MOUNT_POINT" &
FUSE_PID=$!

# Wait for mount to establish
sleep 3

echo "Starting command server..."
node /app/dist/command-server.js &
CMD_PID=$!

echo "All services running (bridge=$BRIDGE_PID, fuse=$FUSE_PID, cmd=$CMD_PID)"

# Wait for any child to exit
wait $BRIDGE_PID $FUSE_PID $CMD_PID
