#!/usr/bin/env bash
set -euo pipefail

echo "=== QWAI Security Scan ==="
echo ""

ISSUES=0

# 1. Secrets in codebase
echo "[1/6] Scanning for hardcoded secrets..."
SECRETS=$(grep -rn --include="*.ts" --include="*.tsx" --include="*.js" --include="*.json" \
  -E "(sk-[a-zA-Z0-9]{20,}|AKIA[A-Z0-9]{16}|ghp_[a-zA-Z0-9]{36}|password\s*=\s*['\"][^'\"]{8,})" \
  apps/ packages/ 2>/dev/null | grep -v node_modules | grep -v ".env" | grep -v "placeholder" | grep -v "test" || true)
if [ -n "$SECRETS" ]; then
  echo "  WARNING: Potential secrets found:"
  echo "$SECRETS" | head -10
  ISSUES=$((ISSUES + 1))
else
  echo "  OK: No hardcoded secrets detected"
fi

# 2. .env files not gitignored
echo ""
echo "[2/6] Checking .env files..."
ENV_TRACKED=$(git ls-files '*.env' '.env*' 2>/dev/null | grep -v ".env.example" || true)
if [ -n "$ENV_TRACKED" ]; then
  echo "  WARNING: .env files tracked by git: $ENV_TRACKED"
  ISSUES=$((ISSUES + 1))
else
  echo "  OK: .env files not tracked"
fi

# 3. Dependency audit
echo ""
echo "[3/6] Running pnpm audit..."
AUDIT_OUT=$(pnpm audit --json 2>/dev/null || true)
HIGH=$(echo "$AUDIT_OUT" | grep -c '"severity":"high"' 2>/dev/null || echo 0)
CRIT=$(echo "$AUDIT_OUT" | grep -c '"severity":"critical"' 2>/dev/null || echo 0)
echo "  High: $HIGH | Critical: $CRIT"
if [ "$CRIT" -gt 0 ]; then
  echo "  WARNING: Critical vulnerabilities found. Run 'pnpm audit' for details."
  ISSUES=$((ISSUES + 1))
fi

# 4. SQL injection vectors
echo ""
echo "[4/6] Checking for raw SQL usage..."
RAW_SQL=$(grep -rn --include="*.ts" '\$queryRaw\|\.query(\|\.exec(' apps/api/src/ 2>/dev/null | grep -v node_modules | grep -v "circuit-breaker" || true)
RAW_COUNT=$(echo "$RAW_SQL" | grep -c . 2>/dev/null || echo 0)
if [ "$RAW_COUNT" -gt 0 ]; then
  echo "  INFO: $RAW_COUNT raw SQL usages found (review for injection risk):"
  echo "$RAW_SQL" | head -5
else
  echo "  OK: No raw SQL detected (Prisma ORM only)"
fi

# 5. JWT configuration
echo ""
echo "[5/6] Checking JWT configuration..."
JWT_HARDCODED=$(grep -rn "dev-secret-change-me" apps/api/src/ 2>/dev/null | grep -v node_modules || true)
if [ -n "$JWT_HARDCODED" ]; then
  echo "  WARNING: Hardcoded JWT fallback secret found (ok for dev, remove before prod)"
else
  echo "  OK: No hardcoded JWT secrets"
fi

# 6. CORS configuration
echo ""
echo "[6/6] Checking CORS configuration..."
CORS_STAR=$(grep -rn "origin.*['\"]\\*['\"]" apps/api/src/ 2>/dev/null | grep -v node_modules || true)
if [ -n "$CORS_STAR" ]; then
  echo "  WARNING: CORS origin: '*' found (tighten for production):"
  echo "$CORS_STAR" | head -3
  ISSUES=$((ISSUES + 1))
else
  echo "  OK: No wildcard CORS"
fi

echo ""
echo "=== Scan complete: $ISSUES issue(s) found ==="
exit "$ISSUES"
