import { Injectable, Logger } from '@nestjs/common';
import Safe from '@safe-global/protocol-kit';
import SafeApiKit from '@safe-global/api-kit';

const SAFE_CHAIN_IDS: Record<number, boolean> = {
  1: true,
  42161: true,
  8453: true,
};

export interface SafeVault {
  safeAddress: string;
  threshold: number;
  owners: string[];
  chainId: number;
}

export interface SafePendingTx {
  safeTxHash: string;
  to: string;
  data: string;
  value: string;
  confirmationsRequired: number;
  confirmations: number;
}

@Injectable()
export class SafeClient {
  private readonly logger = new Logger(SafeClient.name);

  private apiKit(chainId: number): SafeApiKit {
    if (!SAFE_CHAIN_IDS[chainId]) throw new Error(`No Safe Transaction Service for chainId=${chainId}`);
    return new SafeApiKit({ chainId: BigInt(chainId) });
  }

  /**
   * Deploy a new Safe with the given owners and threshold.
   * The `deployerPrivateKey` pays the deployment gas.
   */
  async deploySafe(
    rpcUrl: string,
    chainId: number,
    deployerPrivateKey: string,
    owners: string[],
    threshold: number,
  ): Promise<SafeVault> {
    const protocolKit = await Safe.init({
      provider: rpcUrl,
      signer: deployerPrivateKey,
      predictedSafe: {
        safeAccountConfig: { owners, threshold },
        safeDeploymentConfig: {},
      },
    });

    const safeAddress = await protocolKit.getAddress();
    const deploymentTx = await protocolKit.createSafeDeploymentTransaction();
    const safeProvider = protocolKit.getSafeProvider();
    const externalProvider = await safeProvider.getExternalProvider();
    // Use the underlying ethers signer to send the deployment transaction
    const { ethers } = await import('ethers');
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const wallet = new ethers.Wallet(deployerPrivateKey, provider);
    const sent = await wallet.sendTransaction({
      to: deploymentTx.to,
      value: BigInt(deploymentTx.value ?? '0'),
      data: deploymentTx.data,
    });
    await sent.wait();
    this.logger.log(`Safe deployed: address=${safeAddress} txHash=${sent.hash} chainId=${chainId}`);

    return { safeAddress, threshold, owners, chainId };
  }

  /**
   * Propose a Safe transaction (e.g. a 1inch swap calldata).
   * The proposer signs and posts to the Safe Transaction Service.
   */
  async proposeTransaction(
    rpcUrl: string,
    chainId: number,
    signerPrivateKey: string,
    safeAddress: string,
    to: string,
    data: string,
    value: string,
  ): Promise<string> {
    const protocolKit = await Safe.init({
      provider: rpcUrl,
      signer: signerPrivateKey,
      safeAddress,
    });

    const safeTransactionData = { to, data, value };
    const safeTransaction = await protocolKit.createTransaction({ transactions: [safeTransactionData] });
    const safeTxHash = await protocolKit.getTransactionHash(safeTransaction);
    const senderSignature = await protocolKit.signHash(safeTxHash);
    const signerAddress = await protocolKit.getSafeProvider().getSignerAddress();

    const api = this.apiKit(chainId);
    await api.proposeTransaction({
      safeAddress,
      safeTransactionData: safeTransaction.data,
      safeTxHash,
      senderAddress: signerAddress as string,
      senderSignature: senderSignature.data,
    });

    this.logger.log(`Safe tx proposed: safe=${safeAddress} hash=${safeTxHash} chainId=${chainId}`);
    return safeTxHash;
  }

  /** Confirm a pending Safe transaction on behalf of one owner. */
  async confirmTransaction(
    rpcUrl: string,
    chainId: number,
    signerPrivateKey: string,
    safeAddress: string,
    safeTxHash: string,
  ): Promise<void> {
    const protocolKit = await Safe.init({
      provider: rpcUrl,
      signer: signerPrivateKey,
      safeAddress,
    });

    const signature = await protocolKit.signHash(safeTxHash);
    const api = this.apiKit(chainId);
    await api.confirmTransaction(safeTxHash, signature.data);
    this.logger.log(`Safe tx confirmed: hash=${safeTxHash} chainId=${chainId}`);
  }

  /** Execute a Safe transaction once it has enough confirmations. */
  async executeTransaction(
    rpcUrl: string,
    chainId: number,
    executorPrivateKey: string,
    safeAddress: string,
    safeTxHash: string,
  ): Promise<string> {
    const api = this.apiKit(chainId);
    const safeTransaction = await api.getTransaction(safeTxHash);

    const protocolKit = await Safe.init({
      provider: rpcUrl,
      signer: executorPrivateKey,
      safeAddress,
    });

    const executeTxResponse = await protocolKit.executeTransaction(safeTransaction as any);
    const receipt = await (executeTxResponse.transactionResponse as any)?.wait?.();
    const txHash: string = receipt?.hash ?? (executeTxResponse as any).hash ?? safeTxHash;
    this.logger.log(`Safe tx executed: hash=${txHash} chainId=${chainId}`);
    return txHash;
  }

  /** List pending transactions for a Safe. */
  async getPendingTransactions(chainId: number, safeAddress: string): Promise<SafePendingTx[]> {
    const api = this.apiKit(chainId);
    const result = await api.getPendingTransactions(safeAddress);
    return ((result as any).results ?? []).map((tx: any) => ({
      safeTxHash: tx.safeTxHash,
      to: tx.to,
      data: tx.data ?? '0x',
      value: tx.value ?? '0',
      confirmationsRequired: tx.confirmationsRequired,
      confirmations: tx.confirmations?.length ?? 0,
    }));
  }
}
