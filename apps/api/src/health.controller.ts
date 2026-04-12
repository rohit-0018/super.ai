import { Controller, Get } from '@nestjs/common';
import { getNetworkConfig } from './common/network-config';

@Controller('health')
export class HealthController {
  @Get()
  health() {
    const net = getNetworkConfig();
    return { ok: true, service: 'qwai-api', ts: Date.now(), network: net.mode, isTestnet: net.isTestnet };
  }
}
