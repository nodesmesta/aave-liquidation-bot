import { createWalletClient as viemCreateWalletClient, http } from 'viem';
import { privateKeyToAccount, mnemonicToAccount, PrivateKeyAccount } from 'viem/accounts';
import { base } from 'viem/chains';
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
 * @notice Create viem wallet client for transaction signing
 * @dev Uses account from createAccount() with configured RPC
 * @param rpcUrl RPC endpoint URL
 * @return Viem wallet client instance
 */
export function createWalletClient(rpcUrl: string) {
  const account = createAccount();
  return viemCreateWalletClient({
    account,
    chain: base,
    transport: http(rpcUrl),
  });
}
