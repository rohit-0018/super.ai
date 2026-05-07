import { Controller, Get, Param, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { TokenAnalysisService } from './token-analysis.service';
import { PROFILES, type TradingProfile, type ReportDepth } from './profile.config';

/**
 * GET /intel/:address
 *   ?depth=quick|alpha|dossier        report depth (default: alpha)
 *   ?profile=meme_hunter|degen_sniper|swing_trader|gem_hunt|alpha_hunt
 *   ?force=true                        bypass all caches
 *   ?portfolioUsd=10000                dollar position sizing
 *
 * Back-compat: format=short → quick, format=detailed → alpha
 */
@Controller('intel')
export class IntelController {
  constructor(private readonly svc: TokenAnalysisService) {}

  @Get('profiles')
  getProfiles() {
    return Object.values(PROFILES).map((p) => ({
      key: p.key,
      label: p.label,
      tagline: p.tagline,
      color: p.color,
    }));
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get(':address')
  analyze(
    @Param('address') address: string,
    @Query('format') format?: string,
    @Query('depth') depth?: string,
    @Query('profile') profile?: string,
    @Query('force') force?: string,
    @Query('portfolioUsd') portfolioUsd?: string,
    @Query('noAi') noAi?: string,
  ) {
    const forceRefresh = force === 'true' || force === '1';
    const portUsd = portfolioUsd ? parseFloat(portfolioUsd) : null;
    const skipAi = noAi === 'true' || noAi === '1';

    const rawDepth = depth ?? format;
    let resolvedDepth: ReportDepth = 'alpha';
    if (rawDepth === 'quick' || rawDepth === 'short') resolvedDepth = 'quick';
    else if (rawDepth === 'dossier') resolvedDepth = 'dossier';

    if (resolvedDepth === 'quick') return this.svc.analyzeShort(address);

    const resolvedProfile = (profile as TradingProfile) ?? 'meme_hunter';
    return this.svc.analyzeWithProfile(address, resolvedProfile, resolvedDepth, forceRefresh, portUsd, undefined, skipAi);
  }
}
