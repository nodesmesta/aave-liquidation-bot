import { PublicClient } from 'viem';
import { logger } from '../utils/logger';

/**
 * NonceManager: Thread-safe nonce management for parallel transactions
 * 
 * Problem: Viem's auto-nonce fetches from RPC every time, causing race conditions
 * when multiple transactions execute simultaneously.
 * 
 * Solution: Track nonce locally with mutex-like behavior using promises.
 */
export class NonceManager {
  private currentNonce: number | null = null;
  private initPromise: Promise<void> | null = null;
  private pendingNonces: Set<number> = new Set();
  
  constructor(
    private publicClient: PublicClient,
    private walletAddress: `0x${string}`
  ) {}
  
  /**
   * Initialize nonce from blockchain (call once at startup)
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
   * Get next available nonce (thread-safe)
   * Returns nonce and a callback to release it if TX fails
   */
  async getNextNonce(): Promise<{
    nonce: number;
    release: () => void;
  }> {
    // Ensure initialized
    if (this.currentNonce === null) {
      await this.initialize();
    }
    
    const nonce = this.currentNonce!;
    this.currentNonce!++; // Increment for next call
    this.pendingNonces.add(nonce);
    
    logger.debug(`[NonceManager] Allocated nonce: ${nonce} (pending: ${this.pendingNonces.size})`);
    
    // Release callback (if TX fails before broadcast)
    const release = () => {
      this.pendingNonces.delete(nonce);
      logger.debug(`[NonceManager] Released nonce: ${nonce}`);
    };
    
    return { nonce, release };
  }
  
  /**
   * Mark nonce as confirmed (TX successfully broadcasted)
   */
  confirmNonce(nonce: number): void {
    this.pendingNonces.delete(nonce);
    logger.debug(`[NonceManager] Confirmed nonce: ${nonce} (pending: ${this.pendingNonces.size})`);
  }
  
  /**
   * Sync with blockchain (call if nonce mismatch detected)
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
   * Get current state (for debugging)
   */
  getState(): { current: number | null; pending: number[] } {
    return {
      current: this.currentNonce,
      pending: Array.from(this.pendingNonces).sort((a, b) => a - b)
    };
  }
}
