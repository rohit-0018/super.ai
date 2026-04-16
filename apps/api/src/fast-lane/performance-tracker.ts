export interface PerfCheckpoint {
  name: string;
  absoluteMs: number;   // ms since epoch
  deltaMs: number;      // ms since previous checkpoint
  cumulativeMs: number; // ms since start
}

export interface PerfReport {
  tradeId: string;
  channel: string;
  totalMs: number;
  checkpoints: PerfCheckpoint[];
  startedAt: string;   // ISO timestamp
  finishedAt: string;  // ISO timestamp
}

export class PerformanceTracker {
  private startNs: bigint;
  private lastNs: bigint;
  private startDate: Date;
  private checkpoints: PerfCheckpoint[] = [];
  private _tradeId: string = '';
  private _channel: string = '';

  constructor() {
    this.startNs = process.hrtime.bigint();
    this.lastNs = this.startNs;
    this.startDate = new Date();
  }

  setMeta(tradeId: string, channel: string) {
    this._tradeId = tradeId;
    this._channel = channel;
  }

  mark(name: string): void {
    const now = process.hrtime.bigint();
    const deltaNs = now - this.lastNs;
    const cumulativeNs = now - this.startNs;

    this.checkpoints.push({
      name,
      absoluteMs: Date.now(),
      deltaMs: Number(deltaNs) / 1_000_000,
      cumulativeMs: Number(cumulativeNs) / 1_000_000,
    });

    this.lastNs = now;
  }

  report(): PerfReport {
    const finishedAt = new Date();
    const totalNs = process.hrtime.bigint() - this.startNs;

    return {
      tradeId: this._tradeId,
      channel: this._channel,
      totalMs: Number(totalNs) / 1_000_000,
      checkpoints: [...this.checkpoints],
      startedAt: this.startDate.toISOString(),
      finishedAt: finishedAt.toISOString(),
    };
  }

  totalMs(): number {
    const elapsedNs = process.hrtime.bigint() - this.startNs;
    return Number(elapsedNs) / 1_000_000;
  }
}
