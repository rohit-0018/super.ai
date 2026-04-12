import type { Request, Response, NextFunction } from 'express';
import { SecurityError, SecurityErrorCode } from '../types/errors.js';
import { RiskLevel } from '../types/events.js';

// ─── Allowed Methods & Headers ──────────────────────────────────────────────

const ALLOWED_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
const ALLOWED_HEADERS = 'Content-Type, Authorization, X-Request-ID, X-Correlation-ID';

// ─── Factory ────────────────────────────────────────────────────────────────

export function createCorsMiddleware(
  allowedOrigins: readonly string[],
  environment: string,
): (req: Request, res: Response, next: NextFunction) => void {
  // Startup validation: wildcard in production is a security error
  if (environment === 'production' && allowedOrigins.includes('*')) {
    throw new SecurityError(
      'Wildcard origin is not allowed in production',
      SecurityErrorCode.AUTHZ_RESOURCE_FORBIDDEN,
      RiskLevel.CRITICAL,
      'cors-startup',
      { allowedOrigins },
    );
  }

  const originsSet = new Set(allowedOrigins);

  return function corsMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const origin = req.get('Origin');

    // No Origin header (same-origin or non-browser) - let through
    if (origin === undefined || origin === '') {
      next();
      return;
    }

    // Strict equality check against allowlist
    if (!originsSet.has(origin)) {
      res.status(403).end();
      return;
    }

    // Set CORS headers - always the exact requesting origin, never wildcard
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
    res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');

    // Handle preflight
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    next();
  };
}
