import { createWalletClient as viemCreateWalletClient, http, type WalletClient } from 'viem';
import { privateKeyToAccount, mnemonicToAccount } from 'viem/accounts';
import { basePreconf } from 'viem/chains';
import { config } from '../config';

/**
 * @notice Create viem account from private key or mnemonic
 * @dev Returns PrivateKeyAccount for wallet operations
 * @return Viem account instance
 */
export function createAccount() {
  if (config.wallet.mnemonic) {
    return mnemonicToAccount(config.wallet.mnemonic);
  }
  if (config.wallet.privateKey) {
    return privateKeyToAccount(config.wallet.privateKey as `0x${string}`);
  }
  throw new Error('No wallet credentials provided (PRIVATE_KEY or MNEMONIC)');
}

/**
 * @notice Create viem wallet client for transaction signing with Flashblocks
 * @dev ALWAYS uses basePreconf default (flashblocks) - DO NOT pass custom RPC for TX broadcast
 * @dev For read operations, use createPublicClient with Alchemy instead
 * @return Viem wallet client instance with flashblocks endpoint
 */
export function createWalletClient(): WalletClient {
  const account = createAccount();
  return viemCreateWalletClient({
    account,
    chain: basePreconf,
    transport: http(),
  });
}

