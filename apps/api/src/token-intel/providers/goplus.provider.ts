import { Injectable } from '@nestjs/common';
import axios from 'axios';

@Injectable()
export class GoPlusProvider {
  private base = 'https://api.gopluslabs.io/api/v1';

  async tokenSecurity(chainId: string, address: string) {
    const r = await axios.get(`${this.base}/token_security/${chainId}`, {
      params: { contract_addresses: address },
      timeout: 10_000,
    });
    return r.data?.result?.[address.toLowerCase()] ?? null;
  }
}
