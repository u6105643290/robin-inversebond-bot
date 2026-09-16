// snipe.js — Sniper de lancement ROBIN V2 (Sherwood) sur Robinhood Chain.
//
// Strategie: spam cadence de transactions d'achat pre-signees pendant la fenetre
// de lancement. Avant le finalize() de l'equipe le pool est vide, donc chaque tx
// revert (cout: du gas, ~0.000015). Des que la liquidite apparait, la premiere tx
// qui atterrit passe. En parallele on lit les reserves (gratuit) pour detecter le
// lancement et pour s'arreter des qu'on a achete.
//
// IMPORTANT: le token ROBIN preleve une taxe d'achat de 5% (BUY_TAX_BPS=500), donc
// on utilise swapExactTokensForTokensSupportingFeeOnTransferTokens: amountOutMin est
// verifie sur le montant REELLEMENT recu (apres taxe), pas sur la sortie AMM brute.
import 'dotenv/config';
import { ethers } from 'ethers';

const CHAIN_ID = 4663;
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const ROBIN = '0x7219Bae4a491F1D922e499B568ca1c7Dd483887A';
const ROUTER = '0x89e5DB8B5aA49aA85AC63f691524311AEB649eba';
const PAIR = '0x4E9F826832Cf5f161aAe6dae09406A2Fe7d9545F';
const PRESALE = '0x661c299E5E1b3cb924849A3fCd2ea7B732C8572a';
const USDG_DECIMALS = 6;
const ROBIN_DECIMALS = 9;

const cfg = {
  rpcUrl: process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com',
  sequencerUrl: process.env.SEQUENCER_URL || 'https://sequencer.mainnet.chain.robinhood.com',
  dryRun: (process.env.SNIPE_DRY_RUN ?? 'true').trim().toLowerCase() !== 'false',
  usdgIn: ethers.parseUnits((process.env.SNIPE_USDG_IN || '500').trim(), USDG_DECIMALS),
  minRobinOut: ethers.parseUnits((process.env.SNIPE_MIN_ROBIN_OUT || '35').trim(), ROBIN_DECIMALS),
  spamMs: Math.max(10, Number(process.env.SNIPE_SPAM_MS || 40)),
  batchSize: Math.max(2, Number(process.env.SNIPE_BATCH || 60)),
  gasLimit: BigInt(process.env.SNIPE_GAS_LIMIT || 800000),
  priorityGwei: Number(process.env.SNIPE_PRIORITY_GWEI || 0),
  feeMult: Math.max(1, Number(process.env.SNIPE_FEE_MULT || 3)),
  maxSpend: ethers.parseEther(process.env.SNIPE_MAX_GAS_SPEND || '0.05'), // garde-fou gas total
};

const provider = new ethers.JsonRpcProvider(cfg.rpcUrl, CHAIN_ID, { staticNetwork: true });
const key = (process.env.PRIVATE_KEY || '').trim();
if (!key) { console.error('PRIVATE_KEY manquante dans .env'); process.exit(1); }
const wallet = new ethers.Wallet(key, provider);

const routerIface = new ethers.Interface([
  'function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline)',
]);
const erc20 = new ethers.Contract(USDG, [
  'function balanceOf(address) view returns(uint256)',
  'function allowance(address,address) view returns(uint256)',
], provider);
const robin = new ethers.Contract(ROBIN, ['function balanceOf(address) view returns(uint256)'], provider);
const pair = new ethers.Contract(PAIR, ['function getReserves() view returns (uint112,uint112,uint32)'], provider);
const presale = new ethers.Contract(PRESALE, ['function finalized() view returns(bool)'], provider);

const ts = () => new Date().toISOString().replace('T', ' ').slice(11, 23);
const log = (...a) => console.log(`[${ts()}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errMsg = (e) => (e?.shortMessage || e?.message || String(e)).split('\n')[0].slice(0, 160);

let nonce = 0;
let signed = [];          // file de tx pre-signees prete a tirer
let sent = 0, reverted = 0, gasSpent = 0n;
let launched = false;     // reserves detectees non nulles
let done = false;         // on detient du ROBIN -> stop

// Garde la connexion TLS au sequenceur chaude (evite le handshake au moment du tir)
async function warm() {
  try {
    await fetch(cfg.sequencerUrl, {
      method: 'POST', headers: { 'content-type': 'application/json', connection: 'keep-alive' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'net_version', params: [] }),
    });
  } catch { /* seule la connexion compte */ }
}

async function sendRaw(raw) {
  const r = await fetch(cfg.sequencerUrl, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [raw] }),
  });
  const j = await r.json();
  if (j?.result) return j.result;
  throw new Error(j?.error?.message || 'reponse sequenceur inattendue');
}

// Pre-signe un lot de tx d'achat avec des nonces sequentiels.
async function signBatch() {
  const fees = await provider.getFeeData();
  const base = fees.maxFeePerGas ?? fees.gasPrice ?? 0n;
  const prio = ethers.parseUnits(String(cfg.priorityGwei), 9);
  const maxFee0 = (base * BigInt(Math.round(cfg.feeMult * 100))) / 100n;
  const maxFee = maxFee0 > prio + base ? maxFee0 : prio + base;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 7200); // +2h
  const data = routerIface.encodeFunctionData('swapExactTokensForTokensSupportingFeeOnTransferTokens', [
    cfg.usdgIn, cfg.minRobinOut, [USDG, ROBIN], wallet.address, deadline,
  ]);
  const out = [];
  for (let i = 0; i < cfg.batchSize; i++) {
    const raw = await wallet.signTransaction({
      to: ROUTER, data, value: 0n, nonce: nonce + i, gasLimit: cfg.gasLimit,
      maxFeePerGas: maxFee, maxPriorityFeePerGas: prio, type: 2, chainId: CHAIN_ID,
    });
    out.push({ raw, nonce: nonce + i });
  }
  signed = out;
  log(`lot pre-signe: ${out.length} tx, nonces ${out[0].nonce}..${out[out.length - 1].nonce} | maxFee ${ethers.formatUnits(maxFee, 9)} gwei`);
}

// Surveille les reserves de la paire (lecture gratuite) + detient-on du ROBIN ?
async function watch() {
  while (!done) {
    try {
      const [res, bal] = await Promise.all([pair.getReserves(), robin.balanceOf(wallet.address)]);
      if (bal > 0n) {
        done = true;
        log(`✅ ACHAT REUSSI — tu detiens ${ethers.formatUnits(bal, ROBIN_DECIMALS)} ROBIN — arret du spam`);
        return;
      }
      if (!launched && (res[0] > 0n || res[1] > 0n)) {
        launched = true;
        log(`🚀 LIQUIDITE DETECTEE — reserves: ${res[0]} / ${res[1]}`);
      }
    } catch { /* ignore, on reessaie */ }
    await sleep(50);
  }
}

async function main() {
  log('=== SNIPER ROBIN V2 ===');
  log(`mode      : ${cfg.dryRun ? 'DRY_RUN (aucune tx envoyee)' : '🔥 LIVE'}`);
  log(`wallet    : ${wallet.address}`);
  log(`achat     : ${ethers.formatUnits(cfg.usdgIn, USDG_DECIMALS)} USDG -> min ${ethers.formatUnits(cfg.minRobinOut, ROBIN_DECIMALS)} ROBIN (apres taxe 5%)`);
  log(`cadence   : 1 tx / ${cfg.spamMs} ms (~${Math.round(60000 / cfg.spamMs)} tx/min) | gasLimit ${cfg.gasLimit}`);
  log(`garde-fou : arret si plus de ${ethers.formatEther(cfg.maxSpend)} de gas consomme`);

  // --- verifications de securite avant de commencer ---
  const [bal, allow, rbal, gas, fin] = await Promise.all([
    erc20.balanceOf(wallet.address), erc20.allowance(wallet.address, ROUTER),
    robin.balanceOf(wallet.address), provider.getBalance(wallet.address), presale.finalized(),
  ]);
  log(`USDG solde: ${ethers.formatUnits(bal, USDG_DECIMALS)} | allowance: ${ethers.formatUnits(allow, USDG_DECIMALS)} | gas: ${ethers.formatEther(gas)}`);
  let stop = false;
  if (bal < cfg.usdgIn) { log(`❌ solde USDG insuffisant (besoin ${ethers.formatUnits(cfg.usdgIn, USDG_DECIMALS)})`); stop = true; }
  if (allow < cfg.usdgIn) { log('❌ allowance insuffisante vers le router — relance l\'approbation'); stop = true; }
  if (rbal > 0n) { log(`⚠️ tu detiens deja ${ethers.formatUnits(rbal, ROBIN_DECIMALS)} ROBIN — rien a faire`); stop = true; }
  if (fin) { log('⚠️ la presale est DEJA finalisee — le lancement a eu lieu, verifie le prix avant de sniper'); stop = true; }
  if (gas < ethers.parseEther('0.005')) { log('❌ gas natif trop faible pour soutenir le spam'); stop = true; }
  if (stop) { log('arret.'); return; }

  await warm();
  nonce = await wallet.getNonce('pending');
  log(`nonce de depart: ${nonce}`);
  await signBatch();

  watch().catch((e) => log(`watch: ${errMsg(e)}`));

  log('── debut du spam ──');
  let idx = 0;
  while (!done) {
    if (gasSpent >= cfg.maxSpend) { log(`⛔ garde-fou atteint (${ethers.formatEther(gasSpent)} de gas) — arret`); break; }
    if (idx >= signed.length) { nonce += signed.length; await signBatch(); idx = 0; }

    const tx = signed[idx];
    if (cfg.dryRun) {
      if (idx === 0) log(`DRY_RUN: enverrait nonce ${tx.nonce} (${ethers.formatUnits(cfg.usdgIn, USDG_DECIMALS)} USDG -> min ${ethers.formatUnits(cfg.minRobinOut, ROBIN_DECIMALS)} ROBIN)`);
      idx++; await sleep(cfg.spamMs); continue;
    }

    try {
      const hash = await sendRaw(tx.raw);
      sent++;
      if (sent % 20 === 1 || launched) log(`↗ tx ${sent} envoyee (nonce ${tx.nonce}) ${launched ? '— POST-LANCEMENT' : ''} ${hash.slice(0, 14)}…`);
      provider.waitForTransaction(hash, 1, 60000).then((rc) => {
        if (!rc) return;
        gasSpent += rc.gasUsed * rc.gasPrice;
        if (rc.status === 1) { done = true; log(`✅ TX REUSSIE bloc ${rc.blockNumber} — ${hash}`); }
        else { reverted++; if (launched) log(`❌ revert POST-LANCEMENT bloc ${rc.blockNumber} (trop lent ou minOut trop serre)`); }
      }).catch(() => {});
    } catch (e) {
      const m = errMsg(e);
      if (/nonce/i.test(m)) { nonce = await wallet.getNonce('pending'); await signBatch(); idx = 0; log(`resync nonce -> ${nonce}`); continue; }
      if (sent % 50 === 0) log(`envoi: ${m}`);
    }
    idx++;
    await sleep(cfg.spamMs);
  }

  const finalBal = await robin.balanceOf(wallet.address);
  log(`── fin ── tx envoyees: ${sent} | reverts: ${reverted} | gas consomme: ${ethers.formatEther(gasSpent)}`);
  log(`ROBIN detenu: ${ethers.formatUnits(finalBal, ROBIN_DECIMALS)}`);
}

process.on('SIGINT', () => { log('⏹ arret manuel'); process.exit(0); });
main().catch((e) => { log(`💥 ${errMsg(e)}`); process.exit(1); });
