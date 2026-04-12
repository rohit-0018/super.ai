import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { createCorsMiddleware } from './cors.middleware.js';
import { SecurityError } from '../types/errors.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function mockRequest(overrides: {
  origin?: string;
  method?: string;
} = {}): Request {
  const headers: Record<string, string> = {};
  if (overrides.origin !== undefined) {
    headers['origin'] = overrides.origin;
  }
  return {
    method: overrides.method ?? 'GET',
    headers,
    get(name: string): string | undefined {
      return headers[name.toLowerCase()];
    },
  } as unknown as Request; // untyped mock boundary
}

function mockResponse(): Response {
  const res = {
    setHeader: vi.fn().mockReturnThis(),
    status: vi.fn().mockReturnThis(),
    end: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res as unknown as Response; // untyped mock boundary
}

function mockNext(): NextFunction {
  return vi.fn() as unknown as NextFunction; // untyped mock boundary
}

const ALLOWED_ORIGINS = ['https://app.example.com', 'https://admin.example.com'];

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('createCorsMiddleware', () => {
  let res: Response;
  let next: NextFunction;

  beforeEach(() => {
    res = mockResponse();
    next = mockNext();
  });

  describe('allowed origin', () => {
    it('should set CORS headers for an allowed origin', () => {
      const middleware = createCorsMiddleware(ALLOWED_ORIGINS, 'production');
      const req = mockRequest({ origin: 'https://app.example.com' });

      middleware(req, res, next);

      expect(res.setHeader).toHaveBeenCalledWith(
        'Access-Control-Allow-Origin',
        'https://app.example.com',
      );
      expect(next).toHaveBeenCalledOnce();
    });

    it('should set the exact requesting origin, not a wildcard', () => {
      const middleware = createCorsMiddleware(ALLOWED_ORIGINS, 'production');
      const req = mockRequest({ origin: 'https://admin.example.com' });

      middleware(req, res, next);

      expect(res.setHeader).toHaveBeenCalledWith(
        'Access-Control-Allow-Origin',
        'https://admin.example.com',
      );
      expect(res.setHeader).not.toHaveBeenCalledWith(
        'Access-Control-Allow-Origin',
        '*',
      );
    });

    it('should set Access-Control-Allow-Methods', () => {
      const middleware = createCorsMiddleware(ALLOWED_ORIGINS, 'production');
      const req = mockRequest({ origin: 'https://app.example.com' });

      middleware(req, res, next);

      expect(res.setHeader).toHaveBeenCalledWith(
        'Access-Control-Allow-Methods',
        expect.stringContaining('GET'),
      );
      expect(res.setHeader).toHaveBeenCalledWith(
        'Access-Control-Allow-Methods',
        expect.stringContaining('POST'),
      );
    });

    it('should set Access-Control-Allow-Headers', () => {
      const middleware = createCorsMiddleware(ALLOWED_ORIGINS, 'production');
      const req = mockRequest({ origin: 'https://app.example.com' });

      middleware(req, res, next);

      expect(res.setHeader).toHaveBeenCalledWith(
        'Access-Control-Allow-Headers',
        expect.stringContaining('Authorization'),
      );
    });
  });

  describe('disallowed origin', () => {
    it('should respond with 403 for a disallowed origin', () => {
      const middleware = createCorsMiddleware(ALLOWED_ORIGINS, 'production');
      const req = mockRequest({ origin: 'https://evil.example.com' });

      middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.end).toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
    });

    it('should not set any CORS headers for a disallowed origin', () => {
      const middleware = createCorsMiddleware(ALLOWED_ORIGINS, 'production');
      const req = mockRequest({ origin: 'https://evil.example.com' });

      middleware(req, res, next);

      expect(res.setHeader).not.toHaveBeenCalled();
    });

    it('should allow requests with no Origin header (same-origin)', () => {
      const middleware = createCorsMiddleware(ALLOWED_ORIGINS, 'production');
      const req = mockRequest();

      middleware(req, res, next);

      expect(next).toHaveBeenCalledOnce();
    });
  });

  describe('wildcard in production', () => {
    it('should throw SecurityError when wildcard is used in production', () => {
      expect(() => {
        createCorsMiddleware(['*', 'https://app.example.com'], 'production');
      }).toThrow(SecurityError);
    });

    it('should throw with correct error message', () => {
      expect(() => {
        createCorsMiddleware(['*'], 'production');
      }).toThrow('Wildcard origin is not allowed in production');
    });

    it('should allow wildcard in development', () => {
      expect(() => {
        createCorsMiddleware(['*'], 'development');
      }).not.toThrow();
    });

    it('should allow wildcard in staging', () => {
      expect(() => {
        createCorsMiddleware(['*'], 'staging');
      }).not.toThrow();
    });
  });

  describe('preflight handling', () => {
    it('should respond with 204 for OPTIONS requests from allowed origins', () => {
      const middleware = createCorsMiddleware(ALLOWED_ORIGINS, 'production');
      const req = mockRequest({
        origin: 'https://app.example.com',
        method: 'OPTIONS',
      });

      middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(204);
      expect(res.end).toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
    });

    it('should still set CORS headers on preflight', () => {
      const middleware = createCorsMiddleware(ALLOWED_ORIGINS, 'production');
      const req = mockRequest({
        origin: 'https://app.example.com',
        method: 'OPTIONS',
      });

      middleware(req, res, next);

      expect(res.setHeader).toHaveBeenCalledWith(
        'Access-Control-Allow-Origin',
        'https://app.example.com',
      );
      expect(res.setHeader).toHaveBeenCalledWith(
        'Access-Control-Allow-Methods',
        expect.any(String),
      );
      expect(res.setHeader).toHaveBeenCalledWith(
        'Access-Control-Allow-Headers',
        expect.any(String),
      );
    });

    it('should reject preflight from disallowed origin with 403', () => {
      const middleware = createCorsMiddleware(ALLOWED_ORIGINS, 'production');
      const req = mockRequest({
        origin: 'https://evil.example.com',
        method: 'OPTIONS',
      });

      middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.end).toHaveBeenCalled();
    });
  });

  describe('credentials header', () => {
    it('should set Access-Control-Allow-Credentials to true', () => {
      const middleware = createCorsMiddleware(ALLOWED_ORIGINS, 'production');
      const req = mockRequest({ origin: 'https://app.example.com' });

      middleware(req, res, next);

      expect(res.setHeader).toHaveBeenCalledWith(
        'Access-Control-Allow-Credentials',
        'true',
      );
    });
  });

  describe('Vary header', () => {
    it('should set Vary: Origin for allowed origins', () => {
      const middleware = createCorsMiddleware(ALLOWED_ORIGINS, 'production');
      const req = mockRequest({ origin: 'https://app.example.com' });

      middleware(req, res, next);

      expect(res.setHeader).toHaveBeenCalledWith('Vary', 'Origin');
    });

    it('should not set Vary header for requests without Origin', () => {
      const middleware = createCorsMiddleware(ALLOWED_ORIGINS, 'production');
      const req = mockRequest();

      middleware(req, res, next);

      expect(res.setHeader).not.toHaveBeenCalledWith('Vary', expect.anything());
    });
  });
});
