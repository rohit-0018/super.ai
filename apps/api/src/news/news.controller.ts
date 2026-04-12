import { Controller, DefaultValuePipe, Get, ParseIntPipe, Query } from '@nestjs/common';
import { NewsService } from './news.service';

@Controller('news')
export class NewsController {
  constructor(private svc: NewsService) {}

  @Get()
  latest(@Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number) {
    return this.svc.latest(limit);
  }
}
