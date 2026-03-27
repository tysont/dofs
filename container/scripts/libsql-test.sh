#!/bin/bash
# ABOUTME: Starts the bridge, then runs the libsql test client.
# ABOUTME: Bridge relays Hrana between DO TCP and libsql WS client.

set -e

echo "Starting bridge in background..."
node /app/dist/bridge.js &
BRIDGE_PID=$!

# Wait for bridge to start listening
sleep 1

echo "Starting libsql test..."
node /app/dist/libsql-test.js &
TEST_PID=$!

# Keep running until killed
wait $BRIDGE_PID $TEST_PID
