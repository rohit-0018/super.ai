import { Module, Global } from '@nestjs/common';
import { RateLimitService } from './rate-limit.service';
import { ProviderPoolService } from './provider-pool.service';

@Global()
@Module({
  providers: [RateLimitService, ProviderPoolService],
  exports: [ProviderPoolService],
})
export class ProviderPoolModule {}
