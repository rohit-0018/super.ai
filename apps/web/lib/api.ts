/**
 * Tiny fetch-based API client. Preserves the axios-like surface used across
 * the app: `api.get(path).then(r => r.data)`, `api.post(path, body)`,
 * `api.defaults.baseURL`, `api.defaults.headers.common`, and `setToken()`.
 * No external HTTP deps.
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

  private async request<T>(method: string, path: string, body?: unknown): Promise<ApiResponse<T>> {
    const url = this.defaults.baseURL + path;
    const hasBody = body !== undefined && method !== 'GET' && method !== 'HEAD';
    const headers: HeaderMap = {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...this.defaults.headers.common,
    };

    let resp: Response;
    try {
      resp = await fetch(url, {
        method,
        headers,
        body: hasBody ? JSON.stringify(body) : undefined,
        credentials: 'omit',
      });
    } catch (e: any) {
      throw makeError(e?.message ?? 'Network error', 0, null);
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
      if (resp.status === 401 && typeof window !== 'undefined') {
        window.localStorage.removeItem('qwai.auth');
        if (!window.location.pathname.startsWith('/login')) {
          window.location.href = '/login';
        }
      }
      const message =
        (data && typeof data === 'object' && (data as any).message) || resp.statusText || `HTTP ${resp.status}`;
      throw makeError(message, resp.status, data);
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
