import {
  Injectable,
  Logger,
  OnModuleInit,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UndiciHttpService } from './undici-http.service';

interface PrewarmTarget {
  origin: string;
  path: string;
  name: string;
}

interface PrewarmResult {
  name: string;
  ms: number;
  ok: boolean;
  error?: string;
}

@Injectable()
export class ConnectionPrewarmerService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(ConnectionPrewarmerService.name);
  private interval?: NodeJS.Timeout;
  private readonly enabled: boolean;
  private readonly intervalMs: number;

  constructor(
    private config: ConfigService,
    private http: UndiciHttpService,
  ) {
    this.enabled =
      this.config.get<string>('FAST_LANE_PREWARM_ENABLED', 'true') === 'true';
    this.intervalMs = parseInt(
      this.config.get<string>('FAST_LANE_PREWARM_INTERVAL_MS', '30000'),
      10,
    );
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.log('Connection prewarmer disabled');
      return;
    }
    // Initial prewarm
    await this.prewarmAll().catch((e: Error) =>
      this.logger.warn(`Initial prewarm failed: ${e.message}`),
    );

    // Periodic re-warm
    this.interval = setInterval(() => {
      this.prewarmAll().catch((e: Error) =>
        this.logger.warn(`Prewarm cycle failed: ${e.message}`),
      );
    }, this.intervalMs);
    this.interval.unref(); // don't block process exit

    this.logger.log(
      `Connection prewarmer started (interval=${this.intervalMs}ms)`,
    );
  }

  private async prewarmAll(): Promise<void> {
    const targets: PrewarmTarget[] = [
      {
        origin: 'https://quote-api.jup.ag',
        path: '/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=1000000',
        name: 'Jupiter',
      },
      {
        origin: 'https://api.1inch.dev',
        path: '/swap/v5.2/1/healthcheck',
        name: '1inch',
      },
    ];

    const results = await Promise.allSettled(
      targets.map(async (t): Promise<PrewarmResult> => {
        const start = Date.now();
        try {
          await this.http.request(t.origin, {
            path: t.path,
            method: 'GET',
            timeoutMs: 3000,
          });
          return { name: t.name, ms: Date.now() - start, ok: true };
        } catch (e) {
          return {
            name: t.name,
            ms: Date.now() - start,
            ok: false,
            error: (e as Error).message,
          };
        }
      }),
    );

    const summary = results.map((r) =>
      r.status === 'fulfilled'
        ? r.value
        : { ok: false, error: String(r.reason) },
    );
    this.logger.debug(`Prewarmed connections: ${JSON.stringify(summary)}`);
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
      this.logger.log('Connection prewarmer stopped');
    }
  }
}
