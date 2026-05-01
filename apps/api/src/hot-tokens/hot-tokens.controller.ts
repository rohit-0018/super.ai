import { Controller, Get, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { HotTokensService } from './hot-tokens.service';

@Controller('hot-tokens')
export class HotTokensController {
  constructor(private readonly svc: HotTokensService) {}

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get()
  getLatest(@Query('profile') profile?: string) {
    const key = profile ?? 'meme_hunter';
    const scan = this.svc.getLatest(key);
    if (!scan) return { tokens: [], profileKey: key, scannedAt: null, nextScanAt: null, scanIntervalMs: 600_000, fastScanEnabled: this.svc.fastScan };
    return scan;
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get('all')
  getAllProfiles() {
    return this.svc.getAllLatest() ?? { byProfile: {}, scannedAt: null, nextScanAt: null, scanIntervalMs: 600_000 };
  }
}
