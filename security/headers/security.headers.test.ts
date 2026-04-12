import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { createSecurityHeaders } from './security.headers.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function mockRequest(overrides: Partial<Request> = {}): Request {
  const headers: Record<string, string> = {};
  return {
    protocol: 'https',
    get(name: string): string | undefined {
      return headers[name.toLowerCase()];
    },
    headers,
    ...overrides,
  } as unknown as Request; // untyped mock boundary
}

function mockResponse(): Response {
  const res = {
    setHeader: vi.fn().mockReturnThis(),
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res as unknown as Response; // untyped mock boundary
}

function mockNext(): NextFunction {
  return vi.fn() as unknown as NextFunction; // untyped mock boundary
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('createSecurityHeaders', () => {
  let res: Response;
  let next: NextFunction;

  beforeEach(() => {
    res = mockResponse();
    next = mockNext();
  });

  describe('static security headers', () => {
    it('should set Strict-Transport-Security', () => {
      const middleware = createSecurityHeaders({ environment: 'development' });
      const req = mockRequest();

      middleware(req, res, next);

      expect(res.setHeader).toHaveBeenCalledWith(
        'Strict-Transport-Security',
        'max-age=63072000; includeSubDomains; preload',
      );
    });

    it('should set X-Content-Type-Options to nosniff', () => {
      const middleware = createSecurityHeaders({ environment: 'development' });
      const req = mockRequest();

      middleware(req, res, next);

      expect(res.setHeader).toHaveBeenCalledWith('X-Content-Type-Options', 'nosniff');
    });

    it('should set X-Frame-Options to DENY', () => {
      const middleware = createSecurityHeaders({ environment: 'development' });
      const req = mockRequest();

      middleware(req, res, next);

      expect(res.setHeader).toHaveBeenCalledWith('X-Frame-Options', 'DENY');
    });

    it('should set Referrer-Policy to strict-origin-when-cross-origin', () => {
      const middleware = createSecurityHeaders({ environment: 'development' });
      const req = mockRequest();

      middleware(req, res, next);

      expect(res.setHeader).toHaveBeenCalledWith(
        'Referrer-Policy',
        'strict-origin-when-cross-origin',
      );
    });

    it('should call next()', () => {
      const middleware = createSecurityHeaders({ environment: 'development' });
      const req = mockRequest();

      middleware(req, res, next);

      expect(next).toHaveBeenCalledOnce();
    });
  });

  describe('Content-Security-Policy', () => {
    it('should assemble CSP from default config', () => {
      const middleware = createSecurityHeaders({ environment: 'development' });
      const req = mockRequest();

      middleware(req, res, next);

      expect(res.setHeader).toHaveBeenCalledWith(
        'Content-Security-Policy',
        expect.stringContaining("default-src 'none'"),
      );
      expect(res.setHeader).toHaveBeenCalledWith(
        'Content-Security-Policy',
        expect.stringContaining("script-src 'self'"),
      );
    });

    it('should assemble CSP from custom config with multiple sources', () => {
      const middleware = createSecurityHeaders({
        environment: 'development',
        csp: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", 'https://cdn.example.com'],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'https://images.example.com'],
          connectSrc: ["'self'", 'https://api.example.com'],
          fontSrc: ["'self'", 'https://fonts.googleapis.com'],
          frameSrc: ["'none'"],
          objectSrc: ["'none'"],
        },
      });
      const req = mockRequest();

      middleware(req, res, next);

      const cspCall = vi.mocked(res.setHeader).mock.calls.find(
        (c) => c[0] === 'Content-Security-Policy',
      );
      expect(cspCall).toBeDefined();
      const cspValue = cspCall![1] as string;

      expect(cspValue).toContain("default-src 'self'");
      expect(cspValue).toContain("script-src 'self' https://cdn.example.com");
      expect(cspValue).toContain("style-src 'self' 'unsafe-inline'");
      expect(cspValue).toContain("img-src 'self' data: https://images.example.com");
      expect(cspValue).toContain("connect-src 'self' https://api.example.com");
      expect(cspValue).toContain("font-src 'self' https://fonts.googleapis.com");
      expect(cspValue).toContain("frame-src 'none'");
      expect(cspValue).toContain("object-src 'none'");
    });

    it('should separate CSP directives with semicolons', () => {
      const middleware = createSecurityHeaders({ environment: 'development' });
      const req = mockRequest();

      middleware(req, res, next);

      const cspCall = vi.mocked(res.setHeader).mock.calls.find(
        (c) => c[0] === 'Content-Security-Policy',
      );
      const cspValue = cspCall![1] as string;
      const parts = cspValue.split('; ');
      expect(parts.length).toBe(8);
    });
  });

  describe('Permissions-Policy', () => {
    it('should build Permissions-Policy with empty allow lists by default', () => {
      const middleware = createSecurityHeaders({ environment: 'development' });
      const req = mockRequest();

      middleware(req, res, next);

      const ppCall = vi.mocked(res.setHeader).mock.calls.find(
        (c) => c[0] === 'Permissions-Policy',
      );
      expect(ppCall).toBeDefined();
      const ppValue = ppCall![1] as string;

      expect(ppValue).toContain('camera=()');
      expect(ppValue).toContain('microphone=()');
      expect(ppValue).toContain('geolocation=()');
    });

    it('should build Permissions-Policy with specific origins', () => {
      const middleware = createSecurityHeaders({
        environment: 'development',
        permissionsPolicy: {
          camera: ['self'],
          microphone: ['self', 'https://meet.example.com'],
          geolocation: [],
        },
      });
      const req = mockRequest();

      middleware(req, res, next);

      const ppCall = vi.mocked(res.setHeader).mock.calls.find(
        (c) => c[0] === 'Permissions-Policy',
      );
      const ppValue = ppCall![1] as string;

      expect(ppValue).toContain('camera=(self)');
      expect(ppValue).toContain('microphone=(self "https://meet.example.com")');
      expect(ppValue).toContain('geolocation=()');
    });

    it('should separate Permissions-Policy directives with commas', () => {
      const middleware = createSecurityHeaders({ environment: 'development' });
      const req = mockRequest();

      middleware(req, res, next);

      const ppCall = vi.mocked(res.setHeader).mock.calls.find(
        (c) => c[0] === 'Permissions-Policy',
      );
      const ppValue = ppCall![1] as string;

      // Should contain commas between directives
      expect(ppValue).toMatch(/\w+=\([^)]*\),\s*\w+=\([^)]*\)/);
    });
  });

  describe('HTTPS enforcement', () => {
    it('should reject non-HTTPS requests in production', () => {
      const middleware = createSecurityHeaders({ environment: 'production' });
      const req = mockRequest({ protocol: 'http' });

      middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ error: 'HTTPS required' });
      expect(next).not.toHaveBeenCalled();
    });

    it('should allow HTTPS requests in production', () => {
      const middleware = createSecurityHeaders({ environment: 'production' });
      const req = mockRequest({ protocol: 'https' });

      middleware(req, res, next);

      expect(next).toHaveBeenCalledOnce();
    });

    it('should allow requests with X-Forwarded-Proto: https in production', () => {
      const middleware = createSecurityHeaders({ environment: 'production' });
      const headers: Record<string, string> = { 'x-forwarded-proto': 'https' };
      const req = mockRequest({
        protocol: 'http',
        headers: headers as unknown as Request['headers'], // untyped mock boundary
        get(name: string): string | undefined {
          return headers[name.toLowerCase()];
        },
      });

      middleware(req, res, next);

      expect(next).toHaveBeenCalledOnce();
    });

    it('should allow HTTP in development', () => {
      const middleware = createSecurityHeaders({ environment: 'development' });
      const req = mockRequest({ protocol: 'http' });

      middleware(req, res, next);

      expect(next).toHaveBeenCalledOnce();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('should allow HTTP in staging', () => {
      const middleware = createSecurityHeaders({ environment: 'staging' });
      const req = mockRequest({ protocol: 'http' });

      middleware(req, res, next);

      expect(next).toHaveBeenCalledOnce();
      expect(res.status).not.toHaveBeenCalled();
    });
  });

  describe('config validation', () => {
    it('should throw on invalid config', () => {
      expect(() => createSecurityHeaders({ environment: 'invalid' })).toThrow();
    });

    it('should use defaults when given empty object', () => {
      const middleware = createSecurityHeaders({});
      const req = mockRequest();

      middleware(req, res, next);

      expect(next).toHaveBeenCalledOnce();
      expect(res.setHeader).toHaveBeenCalledWith(
        'Strict-Transport-Security',
        expect.any(String),
      );
    });
  });
});
