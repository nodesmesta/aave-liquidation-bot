import { PublicClient } from 'viem';
import { logger } from '../utils/logger';

export class NonceManager {
  private currentNonce: number | null = null;
  private initPromise: Promise<void> | null = null;
  private pendingNonces: Set<number> = new Set();
  
  constructor(
    private publicClient: PublicClient,
    private walletAddress: `0x${string}`
  ) {}

  /**
   * @notice Initialize nonce from blockchain (call once at startup)
   */
  async initialize(): Promise<void> {
    if (this.initPromise) {
      return this.initPromise;
    }
    
    this.initPromise = (async () => {
      const nonce = await this.publicClient.getTransactionCount({
        address: this.walletAddress,
        blockTag: 'pending'
      });
      this.currentNonce = nonce;
      logger.info(`[NonceManager] Initialized with nonce: ${nonce}`);
    })();
    
    return this.initPromise;
  }

  /**
   * @notice Get next available nonce (sequential execution)
   * @dev Allocates nonce but does NOT increment currentNonce until confirmNonce()
   * @return Object with nonce and release callback for failed transactions
   */
  async getNextNonce(): Promise<{
    nonce: number;
    release: () => void;
  }> {
    if (this.currentNonce === null) {
      await this.initialize();
    }
    const nonce = this.currentNonce!;
    this.pendingNonces.add(nonce);
    
    logger.debug(`[NonceManager] Allocated nonce: ${nonce} (pending: ${this.pendingNonces.size})`);
    const release = () => {
      this.pendingNonces.delete(nonce);
      logger.debug(`[NonceManager] Released nonce: ${nonce} - TX failed before sequencer acceptance`);
    };
    
    return { nonce, release };
  }

  /**
   * @notice Mark nonce as confirmed and increment for next TX
   * @dev ONLY increment currentNonce after sequencer confirms TX acceptance
   * @param nonce The nonce to confirm
   */
  confirmNonce(nonce: number): void {
    this.pendingNonces.delete(nonce);
    this.currentNonce!++;
    logger.debug(`[NonceManager] Confirmed nonce: ${nonce}, next: ${this.currentNonce} (pending: ${this.pendingNonces.size})`);
  }

  /**
   * @notice Sync with blockchain (call if nonce mismatch detected)
   */
  async resync(): Promise<void> {
    const onchainNonce = await this.publicClient.getTransactionCount({
      address: this.walletAddress,
      blockTag: 'pending'
    });
    
    const oldNonce = this.currentNonce;
    this.currentNonce = onchainNonce;
    this.pendingNonces.clear();
    
    logger.warn(`[NonceManager] Resynced nonce: ${oldNonce} → ${onchainNonce}`);
  }

  /**
   * @notice Get current state (for debugging)
   * @return Object with current nonce and pending nonces array
   */
  getState(): { current: number | null; pending: number[] } {
    return {
      current: this.currentNonce,
      pending: Array.from(this.pendingNonces).sort((a, b) => a - b)
    };
  }
}
