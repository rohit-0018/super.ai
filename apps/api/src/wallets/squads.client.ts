import { Injectable, Logger } from '@nestjs/common';
import { Connection, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import * as multisig from '@sqds/multisig';
import { getSolanaRpcUrl } from '../common/network-config';

const { Multisig, Proposal } = multisig.accounts;

// Squads v4 program treasury (fee destination for vault creation)
const SQUADS_TREASURY = new PublicKey('FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH');

export interface SquadsVault {
  multisigPda: string;
  vaultPda: string;
  threshold: number;
  members: string[];
}

export interface SquadsProposal {
  multisigPda: string;
  transactionIndex: bigint;
  status: 'Active' | 'Approved' | 'Rejected' | 'Cancelled' | 'Executed';
}

@Injectable()
export class SquadsClient {
  private readonly logger = new Logger(SquadsClient.name);
  private readonly connection = new Connection(getSolanaRpcUrl(), 'confirmed');

  /**
   * Create a new Squads M-of-N multisig vault.
   * The `creator` keypair pays rent and is added as a member.
   * `additionalMembers` are the co-signer public keys.
   */
  async createVault(
    creator: Keypair,
    members: string[],
    threshold: number,
  ): Promise<SquadsVault> {
    const createKey = Keypair.generate();
    const [multisigPda] = multisig.getMultisigPda({ createKey: createKey.publicKey });
    const [vaultPda] = multisig.getVaultPda({ multisigPda, index: 0 });

    const allMembers = [
      { key: creator.publicKey, permissions: multisig.types.Permissions.all() },
      ...members.map((pk) => ({
        key: new PublicKey(pk),
        permissions: multisig.types.Permissions.all(),
      })),
    ];

    const ix = multisig.instructions.multisigCreateV2({
      treasury: SQUADS_TREASURY,
      createKey: createKey.publicKey,
      creator: creator.publicKey,
      multisigPda,
      configAuthority: null,
      threshold,
      members: allMembers,
      timeLock: 0,
      rentCollector: null,
      memo: undefined,
    });

    const { blockhash } = await this.connection.getLatestBlockhash();
    const msg = new TransactionMessage({
      payerKey: creator.publicKey,
      recentBlockhash: blockhash,
      instructions: [ix],
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    tx.sign([creator, createKey]);

    const sig = await this.connection.sendTransaction(tx);
    await this.connection.confirmTransaction(sig, 'confirmed');
    this.logger.log(`Squads vault created: multisig=${multisigPda} vault=${vaultPda} sig=${sig}`);

    return {
      multisigPda: multisigPda.toBase58(),
      vaultPda: vaultPda.toBase58(),
      threshold,
      members,
    };
  }

  /**
   * Propose a vault transaction (e.g. a Jupiter swap).
   * Returns the transaction index for tracking approvals.
   */
  async proposeTransaction(
    proposer: Keypair,
    multisigPdaStr: string,
    transactionMessage: TransactionMessage,
  ): Promise<bigint> {
    const multisigPda = new PublicKey(multisigPdaStr);
    const multisigInfo = await Multisig.fromAccountAddress(this.connection, multisigPda);
    const transactionIndex = BigInt(Number(multisigInfo.transactionIndex) + 1);

    const createIx = multisig.instructions.vaultTransactionCreate({
      multisigPda,
      transactionIndex,
      creator: proposer.publicKey,
      rentPayer: proposer.publicKey,
      vaultIndex: 0,
      ephemeralSigners: 0,
      transactionMessage,
      memo: undefined,
    });

    const proposeIx = multisig.instructions.proposalCreate({
      multisigPda,
      transactionIndex,
      creator: proposer.publicKey,
      rentPayer: proposer.publicKey,
      isDraft: false,
    });

    const { blockhash } = await this.connection.getLatestBlockhash();
    const msg = new TransactionMessage({
      payerKey: proposer.publicKey,
      recentBlockhash: blockhash,
      instructions: [createIx, proposeIx],
    }).compileToV0Message([]);
    const tx = new VersionedTransaction(msg);
    tx.sign([proposer]);

    const sig = await this.connection.sendTransaction(tx);
    await this.connection.confirmTransaction(sig, 'confirmed');
    this.logger.log(`Squads proposal created: multisig=${multisigPdaStr} index=${transactionIndex} sig=${sig}`);

    return transactionIndex;
  }

  /** Approve a pending proposal on behalf of a member. */
  async approveProposal(
    approver: Keypair,
    multisigPdaStr: string,
    transactionIndex: bigint,
  ): Promise<void> {
    const multisigPda = new PublicKey(multisigPdaStr);
    const ix = multisig.instructions.proposalApprove({
      multisigPda,
      transactionIndex,
      member: approver.publicKey,
      memo: undefined,
    });

    const { blockhash } = await this.connection.getLatestBlockhash();
    const msg = new TransactionMessage({
      payerKey: approver.publicKey,
      recentBlockhash: blockhash,
      instructions: [ix],
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    tx.sign([approver]);

    const sig = await this.connection.sendTransaction(tx);
    await this.connection.confirmTransaction(sig, 'confirmed');
    this.logger.log(`Squads proposal approved: multisig=${multisigPdaStr} index=${transactionIndex} sig=${sig}`);
  }

  /** Execute a proposal that has reached threshold. */
  async executeProposal(
    executor: Keypair,
    multisigPdaStr: string,
    transactionIndex: bigint,
  ): Promise<string> {
    const multisigPda = new PublicKey(multisigPdaStr);
    const ix = await multisig.instructions.vaultTransactionExecute({
      connection: this.connection,
      multisigPda,
      transactionIndex,
      member: executor.publicKey,
    });

    const { blockhash } = await this.connection.getLatestBlockhash();
    const msg = new TransactionMessage({
      payerKey: executor.publicKey,
      recentBlockhash: blockhash,
      instructions: [ix.instruction],
    }).compileToV0Message(ix.lookupTableAccounts);
    const tx = new VersionedTransaction(msg);
    tx.sign([executor]);

    const sig = await this.connection.sendTransaction(tx);
    await this.connection.confirmTransaction(sig, 'confirmed');
    this.logger.log(`Squads proposal executed: multisig=${multisigPdaStr} index=${transactionIndex} sig=${sig}`);
    return sig;
  }

  /** Get the current status of a proposal. */
  async getProposalStatus(
    multisigPdaStr: string,
    transactionIndex: bigint,
  ): Promise<SquadsProposal> {
    const multisigPda = new PublicKey(multisigPdaStr);
    const [proposalPda] = multisig.getProposalPda({ multisigPda, transactionIndex });
    const proposal = await Proposal.fromAccountAddress(this.connection, proposalPda);

    let status: SquadsProposal['status'] = 'Active';
    const s = proposal.status;
    if ('approved' in s) status = 'Approved';
    else if ('rejected' in s) status = 'Rejected';
    else if ('cancelled' in s) status = 'Cancelled';
    else if ('executed' in s) status = 'Executed';

    return { multisigPda: multisigPdaStr, transactionIndex, status };
  }
}
