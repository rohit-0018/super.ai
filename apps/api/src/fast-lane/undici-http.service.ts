import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'undici';

export interface UndiciRequestOptions {
  path: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface UndiciResponse<T> {
  statusCode: number;
  body: T;
  headers: Record<string, string | string[] | undefined>;
}

@Injectable()
export class UndiciHttpService implements OnModuleDestroy {
  private readonly logger = new Logger(UndiciHttpService.name);
  private readonly pools = new Map<string, Pool>();
  private readonly connections: number;
  private readonly keepAliveMs: number;
  private readonly useUndici: boolean;

  constructor(private config: ConfigService) {
    this.useUndici =
      this.config.get<string>('FAST_LANE_USE_UNDICI_POOL', 'true') === 'true';
    this.connections = parseInt(
      this.config.get<string>('FAST_LANE_UNDICI_CONNECTIONS', '10'),
      10,
    );
    this.keepAliveMs = parseInt(
      this.config.get<string>('FAST_LANE_UNDICI_KEEPALIVE_MS', '60000'),
      10,
    );
  }

  /**
   * Get or create a pool for the given origin (e.g. "https://quote-api.jup.ag").
   * Pools maintain persistent connections with keepalive.
   */
  getPool(origin: string): Pool {
    let pool = this.pools.get(origin);
    if (!pool) {
      pool = new Pool(origin, {
        connections: this.connections,
        keepAliveTimeout: this.keepAliveMs,
        keepAliveMaxTimeout: this.keepAliveMs * 10,
      });
      this.pools.set(origin, pool);
      this.logger.log(
        `Created Undici pool for ${origin} (connections=${this.connections}, keepalive=${this.keepAliveMs}ms)`,
      );
    }
    return pool;
  }

  /**
   * Make a request using the persistent pool.
   * Returns JSON-parsed body. Throws on non-2xx.
   */
  async request<T = unknown>(
    origin: string,
    opts: UndiciRequestOptions,
  ): Promise<UndiciResponse<T>> {
    const pool = this.getPool(origin);
    const response = await pool.request({
      path: opts.path,
      method: opts.method,
      body: opts.body,
      headers: {
        'content-type': 'application/json',
        ...(opts.headers ?? {}),
      },
      headersTimeout: opts.timeoutMs ?? 8000,
      bodyTimeout: opts.timeoutMs ?? 8000,
    });

    // Collect body
    const chunks: Buffer[] = [];
    for await (const chunk of response.body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const text = Buffer.concat(chunks).toString('utf-8');

    let body: T;
    try {
      body = text ? JSON.parse(text) : (undefined as unknown as T);
    } catch {
      body = text as unknown as T;
    }

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`HTTP ${response.statusCode}: ${text.slice(0, 200)}`);
    }

    return {
      statusCode: response.statusCode,
      body,
      headers: response.headers,
    };
  }

  /** Check if Undici pool is enabled via config */
  isEnabled(): boolean {
    return this.useUndici;
  }

  async onModuleDestroy(): Promise<void> {
    for (const [origin, pool] of this.pools) {
      try {
        await pool.close();
        this.logger.log(`Closed Undici pool for ${origin}`);
      } catch (e) {
        this.logger.error(
          `Error closing pool for ${origin}: ${(e as Error).message}`,
        );
      }
    }
    this.pools.clear();
  }
}
