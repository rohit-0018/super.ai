import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { createHash } from 'crypto';
import { Observable, of } from 'rxjs';
import { map } from 'rxjs/operators';

/**
 * EtagInterceptor — auto-revalidation for GET responses.
 *
 * Why: navigation feels slow because the SPA refetches every panel from
 * scratch on every route change, even when the underlying data hasn't moved.
 * With ETag/304 the round-trip drops from "build the JSON + ship it" to
 * "compute hash + send 304" — typically ~5-15ms vs 100-400ms.
 *
 * Behaviour:
 *   - Only kicks in for GET requests with JSON bodies.
 *   - Hashes the response body (sha1 → hex) and emits "ETag: W/\"<hash>\"".
 *   - If the request's If-None-Match matches, drops the body and returns 304.
 *   - Sets Cache-Control: private, no-cache, max-age=0 — meaning the browser
 *     MUST revalidate every nav, but revalidation is cheap (304 hop).
 *
 * Combined with the client's stale-while-revalidate cache (useApi), this
 * gives us instant nav: cached data renders immediately, the 304 request
 * fires and resolves in a few ms, and only on actual change does a payload
 * flow back.
 */
@Injectable()
export class EtagInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest();
    const res = http.getResponse();

    if (req?.method !== 'GET') return next.handle();

    return next.handle().pipe(
      map((body) => {
        // Skip null/undefined/streaming responses — nothing meaningful to hash.
        if (body == null) return body;
        let serialized: string;
        try {
          serialized = JSON.stringify(body);
        } catch {
          return body; // non-serializable (e.g. Buffer/Stream); leave alone
        }
        // Skip very large payloads where the hash cost outweighs the win.
        if (serialized.length > 256_000) {
          res.setHeader('Cache-Control', 'private, no-cache, max-age=0');
          return body;
        }

        const hash = createHash('sha1').update(serialized).digest('hex');
        const etag = `W/"${hash.slice(0, 16)}"`;

        res.setHeader('ETag', etag);
        res.setHeader('Cache-Control', 'private, no-cache, max-age=0');

        const incoming = (req.headers['if-none-match'] as string | undefined) ?? '';
        if (incoming && incoming === etag) {
          res.status(304);
          return null; // Nest will serialize null → empty body for 304
        }

        return body;
      }),
    );
  }
}
