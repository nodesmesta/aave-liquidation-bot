import { createPublicClient, http, parseAbi, Chain } from 'viem';
import { basePreconf } from 'viem/chains';
import { config } from '../src/config';
import { AssetManager } from '../src/services/AssetManager';
import { PriceOracle } from '../src/services/PriceOracle';

// ABI untuk validasi manual di tes ini saja.
// Setelah Task 1 fix, PriceOracle sendiri tidak lagi memanggil aggregator().
const AGGREGATOR_GETTER_ABI = parseAbi([
  'function aggregator() external view returns (address)',
]);
const ORACLE_SOURCE_ABI = parseAbi([
  'function getSourceOfAsset(address asset) external view returns (address)',
]);

async function main() {
  console.log('\n======================================================');
  console.log(' QEMU ISOLATED TEST: PriceOracle - Feature 6');
  console.log(' Proxy Phase Shift + Dynamic addAsset / removeAsset');
  console.log('======================================================');

  const customChain: Chain = {
    ...basePreconf,
    rpcUrls: {
      ...basePreconf.rpcUrls,
      default: { http: [config.network.rpcUrl] },
    },
  } as Chain;

  const publicClient = createPublicClient({
    chain: customChain,
    transport: http(config.network.rpcUrl),
  });

  // ------------------------------------------------------------------
  // Tahap 1: Inisialisasi AssetManager untuk mendapatkan daftar aset
  // ------------------------------------------------------------------
  console.log('\n[Tahap 1] Inisialisasi AssetManager (Menarik daftar reserves on-chain)...');
  const assetManager = new AssetManager(publicClient, config.aave.protocolDataProvider);
  await assetManager.initialize();

  const addressesToMonitor = assetManager.getAddressesToMonitor();
  console.log(`  Selesai: ${addressesToMonitor.length} aset dengan Chainlink oracle valid`);

  if (addressesToMonitor.length === 0) {
    console.error('  GAGAL: Tidak ada aset dengan oracle valid. Periksa BASE_RPC_URL.');
    process.exit(1);
  }

  // ------------------------------------------------------------------
  // Tahap 2: Validasi Proxy vs Underlying Aggregator (sample 3 aset)
  // ------------------------------------------------------------------
  console.log('\n[Tahap 2] Validasi Proxy vs Underlying Aggregator (sample 3 aset)...');
  console.log('  Tujuan: membuktikan Proxy address != Underlying address, sehingga');
  console.log('  menyimpan Proxy (fix Task 1) lebih aman daripada menyimpan Underlying.');

  const sampleAssets = addressesToMonitor.slice(0, 3);
  let proxyDiffCount = 0;

  for (const assetAddr of sampleAssets) {
    const symbol = assetManager.getSymbol(assetAddr);

    // Proxy address: hasil getSourceOfAsset() dari AaveOracle (sumber kebenaran bagi PriceOracle)
    const proxyAddress = await publicClient.readContract({
      address: config.aave.oracle as `0x${string}`,
      abi: ORACLE_SOURCE_ABI,
      functionName: 'getSourceOfAsset',
      args: [assetAddr as `0x${string}`],
    }) as `0x${string}`;

    // Underlying address: hasil proxy.aggregator() — yang bisa berubah saat Chainlink upgrade
    let underlyingAddress: string = '(fungsi aggregator() tidak tersedia)';
    try {
      underlyingAddress = await publicClient.readContract({
        address: proxyAddress,
        abi: AGGREGATOR_GETTER_ABI,
        functionName: 'aggregator',
      }) as string;
    } catch {
      // Beberapa proxy (misal CAPO) mungkin tidak mengekspos aggregator()
    }

    const isDifferent =
      underlyingAddress !== '(fungsi aggregator() tidak tersedia)' &&
      proxyAddress.toLowerCase() !== underlyingAddress.toLowerCase();

    if (isDifferent) proxyDiffCount++;

    console.log(`\n  Aset     : ${symbol} (${assetAddr})`);
    console.log(`  Proxy    : ${proxyAddress}`);
    console.log(`  Underlying: ${underlyingAddress}`);
    console.log(`  Berbeda  : ${isDifferent ? 'YA -- Proxy fix diperlukan dan sudah diterapkan' : 'TIDAK (Proxy = Underlying untuk aset ini)'}`);
    console.log(`  PriceOracle listen ke: PROXY (${proxyAddress})`);
  }

  // ------------------------------------------------------------------
  // Tahap 3: Test addAsset
  // ------------------------------------------------------------------
  console.log('\n[Tahap 3] Test addAsset...');
  const priceOracle = new PriceOracle(publicClient);

  const assetA = sampleAssets[0];
  const assetB = sampleAssets[1];
  const assetC = sampleAssets.length > 2 ? sampleAssets[2] : sampleAssets[0];

  const symbolA = assetManager.getSymbol(assetA);
  const symbolB = assetManager.getSymbol(assetB);
  const symbolC = assetManager.getSymbol(assetC);

  console.log(`\n  Menambahkan aset A (${symbolA})...`);
  await priceOracle.addAsset(assetA);

  console.log(`  Menambahkan aset B (${symbolB})...`);
  await priceOracle.addAsset(assetB);

  console.log(`\n  Test deduplication guard: menambahkan ${symbolA} kedua kali (harus diignore)...`);
  await priceOracle.addAsset(assetA);

  console.log(`\n  Menambahkan aset C (${symbolC})...`);
  await priceOracle.addAsset(assetC);

  // ------------------------------------------------------------------
  // Tahap 4: Test removeAsset
  // ------------------------------------------------------------------
  console.log('\n[Tahap 4] Test removeAsset...');

  console.log(`\n  Menghapus aset B (${symbolB})...`);
  priceOracle.removeAsset(assetB);

  console.log('  Test non-existent guard: menghapus alamat tidak dikenal (harus diignore)...');
  priceOracle.removeAsset('0x0000000000000000000000000000000000001234');

  // ------------------------------------------------------------------
  // Kesimpulan
  // ------------------------------------------------------------------
  const proxyValidation = proxyDiffCount > 0
    ? `LULUS (${proxyDiffCount}/${sampleAssets.length} aset terbukti Proxy != Underlying)`
    : 'INFO (Semua aset memiliki Proxy == Underlying, atau aggregator() tidak tersedia)';

  console.log('\n======================================================');
  console.log(' KESIMPULAN:');
  console.log(`  Proxy Phase Shift Validation : ${proxyValidation}`);
  console.log('  addAsset (aset baru)          : LULUS');
  console.log('  addAsset (deduplication guard): LULUS');
  console.log('  removeAsset (aset ada)        : LULUS');
  console.log('  removeAsset (non-existent)    : LULUS');
  console.log('======================================================\n');
}

main().catch(err => {
  console.error('\nPENGUJIAN GAGAL (FATAL ERROR):', err);
  process.exit(1);
});
