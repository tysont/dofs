#!/bin/bash
# ABOUTME: Starts the bridge and mounts AgentFS via FUSE against the remote DO database.
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
# -f = foreground (keeps process alive in container)
# auth-token is empty string since our Hrana server doesn't require auth
agentfs mount \
    --remote-url "$BRIDGE_WS_URL" \
    --auth-token "" \
    --foreground \
    agent "$MOUNT_POINT" &
FUSE_PID=$!

# Wait for mount to establish
sleep 3

# Verify mount
if mountpoint -q "$MOUNT_POINT" 2>/dev/null || ls "$MOUNT_POINT" >/dev/null 2>&1; then
    echo "FUSE mount established at $MOUNT_POINT"
else
    echo "Warning: mount may not be ready yet"
fi

# Start status server on :4000
node -e "
const http = require('http');
const { execSync } = require('child_process');
http.createServer((req, res) => {
    let status = { mounted: false, entries: [] };
    try {
        execSync('ls $MOUNT_POINT', { timeout: 5000 });
        status.mounted = true;
        status.entries = execSync('ls $MOUNT_POINT', { encoding: 'utf-8', timeout: 5000 }).trim().split('\n').filter(Boolean);
    } catch (e) {
        status.error = e.message;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status));
}).listen(4000, '0.0.0.0', () => console.log('Status server on :4000'));
" &

# Wait for any child to exit
wait $BRIDGE_PID $FUSE_PID
