import { Injectable } from '@nestjs/common';
import { http, HttpError } from '../../common/http';

@Injectable()
export class RugCheckProvider {
  private base = 'https://api.rugcheck.xyz/v1';

  async tokenReport(mint: string) {
    try {
      return await http.get(`${this.base}/tokens/${mint}/report`, { timeoutMs: 10_000 });
    } catch (e) {
      if (e instanceof HttpError) return null;
      throw e;
    }
  }
}
