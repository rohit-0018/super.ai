#!/usr/bin/env bash
set -euo pipefail

# Simple load test using curl + parallel. For production load testing,
# use k6, artillery, or wrk. This script covers basic concurrency checks.
#
# Usage: ./scripts/load-test.sh [BASE_URL] [CONCURRENCY] [REQUESTS]
#
# Example: ./scripts/load-test.sh http://localhost:4400/api 20 200

BASE="${1:-http://localhost:4400/api}"
CONCURRENCY="${2:-20}"
TOTAL="${3:-200}"

echo "=== QWAI Load Test ==="
echo "  Target: $BASE"
echo "  Concurrency: $CONCURRENCY"
echo "  Total requests: $TOTAL"
echo ""

# Health check
echo "[1/4] Health check..."
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/health")
if [ "$STATUS" != "200" ]; then
  echo "FAIL: $BASE/health returned $STATUS"
  exit 1
fi
echo "  OK: $STATUS"

# Unauthenticated endpoints
echo ""
echo "[2/4] GET /market/trending (${CONCURRENCY}x parallel)..."
START=$(date +%s%N)
seq "$TOTAL" | xargs -P "$CONCURRENCY" -I {} \
  curl -s -o /dev/null -w "%{http_code} %{time_total}s\n" "$BASE/market/trending" \
  | tee /tmp/qwai-load-results.txt > /dev/null
END=$(date +%s%N)
ELAPSED=$(( (END - START) / 1000000 ))
OK_COUNT=$(grep -c "^200" /tmp/qwai-load-results.txt || echo 0)
FAIL_COUNT=$(grep -cv "^200" /tmp/qwai-load-results.txt || echo 0)
AVG_TIME=$(awk '{sum += $2} END {printf "%.3f", sum/NR}' /tmp/qwai-load-results.txt)
echo "  Completed: ${ELAPSED}ms | OK: $OK_COUNT | Fail: $FAIL_COUNT | Avg: ${AVG_TIME}s"

# Public leaderboard
echo ""
echo "[3/4] GET /social/leaderboard (${CONCURRENCY}x parallel)..."
START=$(date +%s%N)
seq "$TOTAL" | xargs -P "$CONCURRENCY" -I {} \
  curl -s -o /dev/null -w "%{http_code} %{time_total}s\n" "$BASE/social/leaderboard" \
  | tee /tmp/qwai-load-results-2.txt > /dev/null
END=$(date +%s%N)
ELAPSED=$(( (END - START) / 1000000 ))
OK_COUNT=$(grep -c "^200" /tmp/qwai-load-results-2.txt || echo 0)
FAIL_COUNT=$(grep -cv "^200" /tmp/qwai-load-results-2.txt || echo 0)
AVG_TIME=$(awk '{sum += $2} END {printf "%.3f", sum/NR}' /tmp/qwai-load-results-2.txt)
echo "  Completed: ${ELAPSED}ms | OK: $OK_COUNT | Fail: $FAIL_COUNT | Avg: ${AVG_TIME}s"

# Rate limit check
echo ""
echo "[4/4] Rate limit test (burst 150 requests)..."
RATE_PASS=0
RATE_LIMIT=0
for i in $(seq 150); do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/health")
  if [ "$CODE" = "429" ]; then
    RATE_LIMIT=$((RATE_LIMIT + 1))
  else
    RATE_PASS=$((RATE_PASS + 1))
  fi
done
echo "  Passed: $RATE_PASS | Rate-limited (429): $RATE_LIMIT"
if [ "$RATE_LIMIT" -gt 0 ]; then
  echo "  Rate limiter is working correctly."
else
  echo "  WARNING: No rate limiting observed. Check ThrottlerModule config."
fi

echo ""
echo "=== Load test complete ==="
