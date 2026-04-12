import { Injectable, Logger } from '@nestjs/common';
import { ethers } from 'ethers';

@Injectable()
export class GasSchedulerService {
  private readonly logger = new Logger(GasSchedulerService.name);
  private lastGasGwei: number | null = null;

  async currentGasGwei(): Promise<number> {
    try {
      const provider = new ethers.JsonRpcProvider(process.env.EVM_RPC_URL ?? 'https://eth.llamarpc.com');
      const feeData = await provider.getFeeData();
      const gwei = Number(feeData.gasPrice ?? 0n) / 1e9;
      this.lastGasGwei = gwei;
      return Math.round(gwei * 10) / 10;
    } catch (e: any) {
      this.logger.warn(`Gas fetch failed: ${e.message}`);
      return this.lastGasGwei ?? 30;
    }
  }

  async isGasCheap(thresholdGwei = 25): Promise<boolean> {
    const gas = await this.currentGasGwei();
    return gas <= thresholdGwei;
  }

  async waitForCheapGas(thresholdGwei = 25, maxWaitMs = 300_000): Promise<{ gasGwei: number; waited: boolean }> {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      const gas = await this.currentGasGwei();
      if (gas <= thresholdGwei) return { gasGwei: gas, waited: Date.now() - start > 5000 };
      await new Promise((r) => setTimeout(r, 15_000));
    }
    const fallback = await this.currentGasGwei();
    return { gasGwei: fallback, waited: true };
  }
}
