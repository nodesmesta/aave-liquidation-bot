import { createPublicClient, http, Chain } from 'viem';
import { basePreconf } from 'viem/chains';
import { config } from '../src/config';
import { AssetManager } from '../src/services/AssetManager';

async function main() {
  console.log('\n======================================================');
  console.log(' QEMU ISOLATED TEST: Aave V3 Base Asset Manager');
  console.log('======================================================');
  
  // 1. Inisialisasi Mock RPC terisolasi (meniru env utama)
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

  // 2. Instansiasi Target Object
  const assetManager = new AssetManager(publicClient, config.aave.protocolDataProvider);

  console.log('\n[Tahap 1] Menginisialisasi AssetManager (Menarik data on-chain)...');
  await assetManager.initialize();

  // 3. Validasi Data
  const reserves = assetManager.getAllReserves();
  console.log(`\n[Tahap 2] Memvalidasi ${reserves.length} aset terdaftar (Cache Memory):`);
  
  let validCount = 0;
  for (const r of reserves) {
    const assetConfig = assetManager.getAssetConfig(r.address);
    if (assetConfig) {
      console.log(` ✔ ${r.symbol.padEnd(6)} -> Decimals: ${assetConfig.decimals.toString().padEnd(2)} | Liq Bonus: ${assetConfig.liquidationBonus * 100}%`);
      validCount++;
    } else {
      console.log(` ❌ ${r.symbol.padEnd(6)} -> Konfigurasi Gagal Dimuat!`);
    }
  }

  const monitored = assetManager.getAddressesToMonitor();
  console.log(`\n[Tahap 3] Memvalidasi ${monitored.length} aset dengan Price Feed Oracle Aktif:`);
  monitored.forEach(addr => {
    console.log(` ✔ Oracle Terdeteksi: ${assetManager.getSymbol(addr)} (${addr})`);
  });

  console.log('\n======================================================');
  if (validCount === reserves.length && reserves.length > 0) {
    console.log(' KESIMPULAN: LULUS (Semua data berhasil difetch & di-parsing)');
  } else {
    console.log(' KESIMPULAN: GAGAL (Terdapat data yang *corrupt* atau kosong)');
  }
  console.log('======================================================\n');
}

main().catch(err => {
  console.error('\n❌ PENGUJIAN GAGAL (FATAL ERROR):', err);
  process.exit(1);
});
