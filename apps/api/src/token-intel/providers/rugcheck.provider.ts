import { Injectable } from '@nestjs/common';
import axios from 'axios';

@Injectable()
export class RugCheckProvider {
  private base = 'https://api.rugcheck.xyz/v1';

  async tokenReport(mint: string) {
    const r = await axios.get(`${this.base}/tokens/${mint}/report`, { timeout: 10_000 });
    return r.data ?? null;
  }
}
