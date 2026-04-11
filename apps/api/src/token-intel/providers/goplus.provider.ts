import { Injectable } from '@nestjs/common';
import { http } from '../../common/http';

@Injectable()
export class GoPlusProvider {
  private base = 'https://api.gopluslabs.io/api/v1';

  async tokenSecurity(chainId: string, address: string) {
    const r: any = await http.get(`${this.base}/token_security/${chainId}`, {
      timeoutMs: 10_000,
      params: { contract_addresses: address },
    });
    return r?.result?.[address.toLowerCase()] ?? null;
  }
}
