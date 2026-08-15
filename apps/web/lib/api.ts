/**
 * Tiny fetch-based API client with transparent JWT refresh.
 *
 * On 401 it calls /auth/refresh once (single-flight), swaps in the new access
 * token, and retries the original request. Concurrent 401s share the same
 * in-flight refresh promise. Only when refresh itself fails do we wipe the
 * session and redirect to /login.
 */

type HeaderMap = Record<string, string>;

interface ApiResponse<T = any> {
  data: T;
  status: number;
  headers: HeaderMap;
}

interface Defaults {
  baseURL: string;
  headers: { common: HeaderMap };
}

export interface RefreshHook {
  getRefreshToken: () => string | null;
  onRefreshed: (accessToken: string, refreshToken: string, expiresIn: number) => void;
  onSessionLost: () => void;
}

function makeError(message: string, status: number, data: unknown) {
  const err: any = new Error(message);
  err.response = { status, data, statusText: message };
  return err;
}

function headersToObject(h: Headers): HeaderMap {
  const out: HeaderMap = {};
  h.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

class ApiClient {
  defaults: Defaults = {
    baseURL: process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:4400/api',
    headers: { common: {} },
  };

  private refreshHook: RefreshHook | null = null;
  private refreshInflight: Promise<string | null> | null = null;

  setRefreshHook(hook: RefreshHook | null) {
    this.refreshHook = hook;
  }

  private buildHeaders(hasBody: boolean): HeaderMap {
    return {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...this.defaults.headers.common,
    };
  }

  // ETag cache: path → { etag, body }. Set on 200, sent as If-None-Match,
  // returned on 304. Module-scoped so it survives between requests but resets
  // on full page reload (acceptable trade-off for memory).
  private etagCache = new Map<string, { etag: string; body: unknown; ts: number }>();
  private readonly ETAG_MAX = 200;

  private async doFetch(method: string, path: string, body: unknown, hasBody: boolean): Promise<Response> {
    const url = this.defaults.baseURL + path;
    const headers = this.buildHeaders(hasBody) as Record<string, string>;
    if (method === 'GET') {
      const cached = this.etagCache.get(path);
      if (cached?.etag) headers['If-None-Match'] = cached.etag;
    }
    return fetch(url, {
      method,
      headers,
      body: hasBody ? JSON.stringify(body) : undefined,
      credentials: 'omit',
    });
  }

  /** Single-flight refresh. Returns new access token or null on failure. */
  private async refreshAccessToken(): Promise<string | null> {
    if (this.refreshInflight) return this.refreshInflight;
    const hook = this.refreshHook;
    const refreshToken = hook?.getRefreshToken();
    if (!hook || !refreshToken) return null;

    this.refreshInflight = (async () => {
      try {
        const resp = await fetch(this.defaults.baseURL + '/auth/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
          credentials: 'omit',
        });
        if (!resp.ok) return null;
        const data = await resp.json();
        if (!data?.accessToken || !data?.refreshToken) return null;
        hook.onRefreshed(data.accessToken, data.refreshToken, data.expiresIn ?? 0);
        return data.accessToken as string;
      } catch {
        return null;
      } finally {
        this.refreshInflight = null;
      }
    })();

    return this.refreshInflight;
  }

  private async request<T>(method: string, path: string, body?: unknown, isRetry = false): Promise<ApiResponse<T>> {
    const hasBody = body !== undefined && method !== 'GET' && method !== 'HEAD';

    let resp: Response;
    try {
      resp = await this.doFetch(method, path, body, hasBody);
    } catch (e: any) {
      throw makeError(e?.message ?? 'Network error', 0, null);
    }

    if (resp.status === 401 && !isRetry && !path.startsWith('/auth/')) {
      const attemptedRefresh = this.refreshHook?.getRefreshToken();
      const newToken = await this.refreshAccessToken();
      if (newToken) {
        return this.request<T>(method, path, body, true);
      }

      // Our refresh failed. Before declaring the session dead, let the hook
      // reconcile — another tab may have rotated the token while we were in
      // flight, in which case it adopts the newer pair instead of wiping.
      if (typeof window !== 'undefined') {
        this.refreshHook?.onSessionLost();
        const reconciled = this.refreshHook?.getRefreshToken();
        if (reconciled && reconciled !== attemptedRefresh) {
          return this.request<T>(method, path, body, true);
        }
      }
      throw makeError('Session expired', 401, null);
    }

    // Fast path: server validates our ETag and tells us nothing changed.
    // Reuse the cached body so subscribers get the same object identity.
    if (resp.status === 304 && method === 'GET') {
      const cached = this.etagCache.get(path);
      if (cached) {
        cached.ts = Date.now();
        return { data: cached.body as T, status: 200, headers: headersToObject(resp.headers) };
      }
      // Lost the cache (e.g. full reload between requests) — refetch without
      // the conditional header so the server returns the body.
      const retry = await fetch(this.defaults.baseURL + path, {
        method: 'GET', headers: this.buildHeaders(false), credentials: 'omit',
      });
      resp = retry;
    }

    const ct = resp.headers.get('content-type') ?? '';
    let data: any = null;
    if (resp.status !== 204) {
      if (ct.includes('application/json')) {
        data = await resp.json().catch(() => null);
      } else {
        data = await resp.text().catch(() => '');
      }
    }

    if (!resp.ok) {
      const message =
        (data && typeof data === 'object' && (data as any).message) || resp.statusText || `HTTP ${resp.status}`;
      throw makeError(message, resp.status, data);
    }

    // Store ETag + body for future conditional requests.
    if (method === 'GET' && resp.status === 200) {
      const etag = resp.headers.get('etag');
      if (etag) {
        if (this.etagCache.size >= this.ETAG_MAX) {
          const oldest = this.etagCache.keys().next().value;
          if (oldest) this.etagCache.delete(oldest);
        }
        this.etagCache.set(path, { etag, body: data, ts: Date.now() });
      }
    }
    // Drop ETag on writes — the resource just changed, no point sending the
    // stale validator on the next GET (would just trigger a 304 with old body).
    if (method !== 'GET' && method !== 'HEAD') {
      this.etagCache.clear();
    }

    return { data: data as T, status: resp.status, headers: headersToObject(resp.headers) };
  }

  get<T = any>(path: string) {
    return this.request<T>('GET', path);
  }
  delete<T = any>(path: string) {
    return this.request<T>('DELETE', path);
  }
  post<T = any>(path: string, body?: unknown) {
    return this.request<T>('POST', path, body ?? {});
  }
  put<T = any>(path: string, body?: unknown) {
    return this.request<T>('PUT', path, body ?? {});
  }
  patch<T = any>(path: string, body?: unknown) {
    return this.request<T>('PATCH', path, body ?? {});
  }
}

export const api = new ApiClient();

export function setToken(token: string | null) {
  if (token) api.defaults.headers.common['Authorization'] = `Bearer ${token}`;
  else delete api.defaults.headers.common['Authorization'];
}
