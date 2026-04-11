import { Controller, Get, Param } from '@nestjs/common';
import { MarketDataService } from './market-data.service';

@Controller('market')
export class MarketDataController {
  constructor(private svc: MarketDataService) {}
  @Get('trending') trending() { return this.svc.trending(); }
  @Get('top-movers') movers() { return this.svc.topMovers(); }
  @Get('price/:id') price(@Param('id') id: string) { return this.svc.price(id).then((p) => ({ id, priceUsd: p })); }
}
