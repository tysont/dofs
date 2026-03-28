#!/bin/bash
# ABOUTME: End-to-end test script for DOFS.
# ABOUTME: Tests the full flow: DO write → FUSE read → FUSE write → DO read → persistence.

set -e

BASE="${DOFS_URL:-https://dofs.tyson-s-sandbox.workers.dev}"
VOL="e2e-$(date +%s)"
PASS=0
FAIL=0

check() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "  PASS: $desc"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $desc"
    echo "    expected: $expected"
    echo "    actual:   $actual"
    FAIL=$((FAIL + 1))
  fi
}

check_contains() {
  local desc="$1" expected="$2" actual="$3"
  if echo "$actual" | grep -q "$expected"; then
    echo "  PASS: $desc"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $desc"
    echo "    expected to contain: $expected"
    echo "    actual: $actual"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== DOFS E2E Tests ==="
echo "Base URL: $BASE"
echo "Volume: $VOL"
echo ""

# -- 1. Filesystem (DO SDK, no container) --
echo "1. Filesystem via DO SDK"

curl -sf -X POST "$BASE/fs/write?volume=$VOL&path=/config.json" -d '{"from":"do"}' > /dev/null
check "write file" "ok" "$(curl -sf -X POST "$BASE/fs/write?volume=$VOL&path=/config.json" -d '{"from":"do"}')"

CONTENT=$(curl -sf "$BASE/fs/read?volume=$VOL&path=/config.json")
check "read file" '{"from":"do"}' "$CONTENT"

LS=$(curl -sf "$BASE/fs/ls?volume=$VOL&path=/")
check_contains "list root" "config.json" "$LS"

echo ""

# -- 2. KV store --
echo "2. KV store"

curl -sf -X POST "$BASE/kv/set?volume=$VOL&key=env" -d "production" > /dev/null
KV=$(curl -sf "$BASE/kv/get?volume=$VOL&key=env")
check "kv round-trip" "production" "$KV"

echo ""

# -- 3. Container exec (FUSE mount) --
echo "3. Container exec with FUSE"

# Trigger container setup
EXEC_RESULT=$(curl -sf --max-time 90 -X POST "$BASE/exec?volume=$VOL" \
  -H "Content-Type: application/json" -d '{"command":"cat /volume/config.json"}')
STDOUT=$(echo "$EXEC_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('stdout','').strip())" 2>/dev/null)
check "FUSE reads DO-written file" '{"from":"do"}' "$STDOUT"

# Write from FUSE
curl -sf --max-time 15 -X POST "$BASE/exec?volume=$VOL" \
  -H "Content-Type: application/json" -d '{"command":"echo from-fuse > /volume/output.txt"}' > /dev/null

DO_READ=$(curl -sf "$BASE/fs/read?volume=$VOL&path=/output.txt")
check_contains "DO reads FUSE-written file" "from-fuse" "$DO_READ"

echo ""

# -- 4. Git inside FUSE --
echo "4. Git inside FUSE"

GIT_RESULT=$(curl -sf --max-time 30 -X POST "$BASE/exec?volume=$VOL" \
  -H "Content-Type: application/json" \
  -d '{"command":"cd /volume && git init && echo hello > main.py && git add -A && git -c user.name=dofs -c user.email=dofs@test commit -m init 2>&1"}')
GIT_LOG=$(curl -sf --max-time 10 -X POST "$BASE/exec?volume=$VOL" \
  -H "Content-Type: application/json" -d '{"command":"git -C /volume log --oneline 2>&1"}')
GIT_STDOUT=$(echo "$GIT_LOG" | python3 -c "import sys,json; print(json.load(sys.stdin).get('stdout','').strip())" 2>/dev/null)
check_contains "git commit exists" "init" "$GIT_STDOUT"

LS2=$(curl -sf "$BASE/fs/ls?volume=$VOL&path=/")
check_contains "DO sees .git" ".git" "$LS2"
check_contains "DO sees main.py" "main.py" "$LS2"

echo ""

# -- 5. Persistence across container eviction --
echo "5. Persistence"

curl -sf -X POST "$BASE/destroy?volume=$VOL" > /dev/null
sleep 3

PERSIST=$(curl -sf "$BASE/fs/read?volume=$VOL&path=/main.py")
check_contains "file survives container destroy" "hello" "$PERSIST"

# New container reads via FUSE
NEW_FUSE=$(curl -sf --max-time 90 -X POST "$BASE/exec?volume=$VOL" \
  -H "Content-Type: application/json" -d '{"command":"cat /volume/main.py && git -C /volume log --oneline 2>&1"}')
NEW_STDOUT=$(echo "$NEW_FUSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('stdout','').strip())" 2>/dev/null)
check_contains "new container sees file via FUSE" "hello" "$NEW_STDOUT"
check_contains "new container sees git history" "init" "$NEW_STDOUT"

echo ""

# -- Summary --
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
