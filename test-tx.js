// test-tx.js — envoie UNE transaction volontairement vouée au revert pour valider
// le circuit complet (signature → diffusion → minage). Ne peut rien vendre:
// deposit(1 unité, 0) donne usdgRaw = 0, que le contrat rejette toujours.
// Coût: uniquement le gas de la tx revertée (poussière). À lancer soi-même: node test-tx.js
import 'dotenv/config';
import { ethers } from 'ethers';

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com', 4663, { staticNetwork: true });
const key = (process.env.PRIVATE_KEY || '').trim();
if (!key) {
  console.error('PRIVATE_KEY manquante dans .env');
  process.exit(1);
}
const wallet = new ethers.Wallet(key, provider);
const inverseBond = new ethers.Contract(
  '0xE2a4E905C486de90e82587de66107f77DEb0F6Ca',
  ['function deposit(uint256 robinAmount, uint256 minUsdgRaw) returns (uint256 usdgRaw)'],
  wallet
);

console.log('TEST: envoi réel de deposit(1 unité, 0) depuis', wallet.address);
console.log('      revert garanti (usdgRaw = 0) — rien ne peut être vendu, seul un peu de gas est consommé.');

const before = await provider.getBalance(wallet.address);
try {
  const tx = await inverseBond.deposit(1n, 0n, { gasLimit: 400_000n });
  console.log('↗ tx diffusée:', tx.hash);
  await tx.wait(1, 120_000);
  console.log('⚠️ inattendu: la tx a réussi (elle aurait dû revert)');
} catch (e) {
  if (e?.code === 'CALL_EXCEPTION' && e?.receipt) {
    const after = await provider.getBalance(wallet.address);
    console.log('✅ tx minée et REVERTÉE comme prévu — bloc', e.receipt.blockNumber, '| hash:', e.receipt.hash);
    console.log('   gas consommé:', ethers.formatEther(before - after), '(natif)');
    console.log('   → signature, diffusion et minage fonctionnent. Le circuit est opérationnel.');
  } else {
    console.log('❌ échec avant minage:', (e?.shortMessage || e?.message || String(e)).slice(0, 200));
  }
}
