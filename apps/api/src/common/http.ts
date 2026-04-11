/**
 * Tiny fetch-based HTTP helper for backend outbound calls.
 * Uses Node 20+ native fetch. No external HTTP deps.
 *
 * Features:
 *  - `timeoutMs` via AbortController
 *  - JSON parse with text fallback
 *  - Non-2xx throws an Error with `.status` and `.body` attached
 *  - Query-string builder that skips undefined/null
 */

export type QueryParams = Record<string, string | number | boolean | undefined | null>;

export interface HttpOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  params?: QueryParams;
  body?: unknown; // JSON-stringifyable
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

function buildUrl(base: string, params?: QueryParams): string {
  if (!params) return base;
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    usp.append(k, String(v));
  }
  const qs = usp.toString();
  if (!qs) return base;
  return base + (base.includes('?') ? '&' : '?') + qs;
}

async function request<T = any>(method: string, url: string, opts: HttpOptions = {}): Promise<T> {
  const { headers = {}, timeoutMs = 15_000, params, body } = opts;
  const finalUrl = buildUrl(url, params);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  const init: RequestInit = {
    method,
    headers: {
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    signal: ctrl.signal,
  };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }

  let resp: Response;
  try {
    resp = await fetch(finalUrl, init);
  } catch (e: any) {
    clearTimeout(timer);
    if (e?.name === 'AbortError') {
      throw new HttpError(`Request timed out after ${timeoutMs}ms`, 0, null);
    }
    throw new HttpError(e?.message ?? 'Network error', 0, null);
  }
  clearTimeout(timer);

  const text = await resp.text();
  const ct = resp.headers.get('content-type') ?? '';
  let data: any = null;
  if (text) {
    if (ct.includes('application/json')) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    } else {
      data = text;
    }
  }

  if (!resp.ok) {
    const message =
      (data && typeof data === 'object' && (data.message || data.error)) ||
      `HTTP ${resp.status} ${resp.statusText}`;
    throw new HttpError(message, resp.status, data);
  }

  return data as T;
}

export const http = {
  get: <T = any>(url: string, opts?: HttpOptions) => request<T>('GET', url, opts),
  post: <T = any>(url: string, body?: unknown, opts?: HttpOptions) => request<T>('POST', url, { ...opts, body }),
  put: <T = any>(url: string, body?: unknown, opts?: HttpOptions) => request<T>('PUT', url, { ...opts, body }),
  patch: <T = any>(url: string, body?: unknown, opts?: HttpOptions) => request<T>('PATCH', url, { ...opts, body }),
  delete: <T = any>(url: string, opts?: HttpOptions) => request<T>('DELETE', url, opts),
};
