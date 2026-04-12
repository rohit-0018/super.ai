import { z } from 'zod';
import type { Request, Response, NextFunction } from 'express';

// ─── Typed Config Schemas ───────────────────────────────────────────────────

const PermissionsPolicyConfigSchema = z.object({
  camera: z.array(z.string()).default([]),
  microphone: z.array(z.string()).default([]),
  geolocation: z.array(z.string()).default([]),
  gyroscope: z.array(z.string()).default([]),
  magnetometer: z.array(z.string()).default([]),
  accelerometer: z.array(z.string()).default([]),
  usb: z.array(z.string()).default([]),
  payment: z.array(z.string()).default([]),
  autoplay: z.array(z.string()).default([]),
  fullscreen: z.array(z.string()).default([]),
});

const CspConfigSchema = z.object({
  defaultSrc: z.array(z.string()).default(["'none'"]),
  scriptSrc: z.array(z.string()).default(["'self'"]),
  styleSrc: z.array(z.string()).default(["'self'"]),
  imgSrc: z.array(z.string()).default(["'self'"]),
  connectSrc: z.array(z.string()).default(["'self'"]),
  fontSrc: z.array(z.string()).default(["'self'"]),
  frameSrc: z.array(z.string()).default(["'none'"]),
  objectSrc: z.array(z.string()).default(["'none'"]),
});

const HeadersConfigSchema = z.object({
  environment: z.enum(['development', 'staging', 'production']).default('development'),
  permissionsPolicy: PermissionsPolicyConfigSchema.default({}),
  csp: CspConfigSchema.default({}),
});

export type PermissionsPolicyConfig = z.infer<typeof PermissionsPolicyConfigSchema>;
export type CspConfig = z.infer<typeof CspConfigSchema>;
export type HeadersConfig = z.infer<typeof HeadersConfigSchema>;

// ─── Helpers ────────────────────────────────────────────────────────────────

function buildPermissionsPolicy(config: PermissionsPolicyConfig): string {
  const entries: string[] = [];

  for (const [directive, allowList] of Object.entries(config)) {
    if (allowList.length === 0) {
      entries.push(`${directive}=()`);
    } else {
      const quoted = allowList.map((v: string) =>
        v === 'self' ? 'self' : `"${v}"`,
      );
      entries.push(`${directive}=(${quoted.join(' ')})`);
    }
  }

  return entries.join(', ');
}

function buildCsp(config: CspConfig): string {
  const directives: string[] = [];

  const mapping: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['default-src', config.defaultSrc],
    ['script-src', config.scriptSrc],
    ['style-src', config.styleSrc],
    ['img-src', config.imgSrc],
    ['connect-src', config.connectSrc],
    ['font-src', config.fontSrc],
    ['frame-src', config.frameSrc],
    ['object-src', config.objectSrc],
  ];

  for (const [name, values] of mapping) {
    directives.push(`${name} ${values.join(' ')}`);
  }

  return directives.join('; ');
}

function isHttpsRequest(req: Request): boolean {
  if (req.protocol === 'https') {
    return true;
  }
  const forwardedProto = req.get('X-Forwarded-Proto');
  return forwardedProto === 'https';
}

// ─── Middleware Factory ─────────────────────────────────────────────────────

export function createSecurityHeaders(
  rawConfig: unknown,
): (req: Request, res: Response, next: NextFunction) => void {
  const config = HeadersConfigSchema.parse(rawConfig);
  const permissionsPolicyValue = buildPermissionsPolicy(config.permissionsPolicy);
  const cspValue = buildCsp(config.csp);
  const isProduction = config.environment === 'production';

  return function securityHeadersMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    // In production, enforce HTTPS
    if (isProduction && !isHttpsRequest(req)) {
      res.status(403).json({ error: 'HTTPS required' });
      return;
    }

    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', permissionsPolicyValue);
    res.setHeader('Content-Security-Policy', cspValue);

    next();
  };
}
