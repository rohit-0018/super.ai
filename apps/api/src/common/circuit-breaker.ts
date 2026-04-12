import { Logger } from '@nestjs/common';

type State = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export class CircuitBreaker {
  private state: State = 'CLOSED';
  private failures = 0;
  private lastFailure = 0;
  private readonly logger: Logger;

  constructor(
    private readonly name: string,
    private readonly threshold = 5,
    private readonly resetMs = 30_000,
  ) {
    this.logger = new Logger(`CircuitBreaker:${name}`);
  }

  async exec<T>(fn: () => Promise<T>, fallback?: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailure > this.resetMs) {
        this.state = 'HALF_OPEN';
        this.logger.log(`${this.name} circuit half-open, allowing probe request`);
      } else {
        this.logger.warn(`${this.name} circuit OPEN, using fallback`);
        if (fallback) return fallback();
        throw new Error(`${this.name} circuit breaker is OPEN`);
      }
    }

    try {
      const result = await fn();
      if (this.state === 'HALF_OPEN') {
        this.state = 'CLOSED';
        this.failures = 0;
        this.logger.log(`${this.name} circuit recovered → CLOSED`);
      }
      return result;
    } catch (err) {
      this.failures++;
      this.lastFailure = Date.now();
      if (this.failures >= this.threshold) {
        this.state = 'OPEN';
        this.logger.error(`${this.name} circuit tripped → OPEN after ${this.failures} failures`);
      }
      if (fallback && this.state === 'OPEN') return fallback();
      throw err;
    }
  }

  getState(): { state: State; failures: number } {
    return { state: this.state, failures: this.failures };
  }
}
