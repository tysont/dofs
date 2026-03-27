#!/bin/bash
# ABOUTME: Starts bridge + SDK test that verifies AgentFS operations through Hrana.
# ABOUTME: Bridge relays between DO TCP and libsql WS, test reads/writes AgentFS tables.

set -e

echo "Starting bridge in background..."
node /app/dist/bridge.js &

sleep 1

echo "Starting SDK test..."
node /app/dist/sdk-test.js &

wait
