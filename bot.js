// bot.js — Rachat automatique de ROBIN au prix du backing via InverseBond (Robinhood Chain)
// Deux mécanismes complémentaires:
//   1. POLL   : lit la chaîne en boucle et dépose dès qu'il y a de la capacité (nettoyage des restes).
//   2. SNIPE  : (optionnel) transactions PRÉ-SIGNÉES tirées par minuterie à la seconde exacte de la borne,
//               sans lecture préalable, pour viser le tout premier bloc de la nouvelle epoch.
import 'dotenv/config';
import { ethers } from 'ethers';

// ---------- Chaîne & contrats ----------
const CHAIN_ID = 4663n;
const EPOCH_LEN = 28800; // 8 h — bornes à 00:00, 08:00 et 16:00 UTC
const ROBIN_DECIMALS = 9;
const USDG_DECIMALS = 6;
const ROBIN_UNIT = 10n ** BigInt(ROBIN_DECIMALS);
const BPS = 10_000n;
const GAS_LIMIT = 400_000n;

const ADDR = {
  inverseBond: '0xE2a4E905C486de90e82587de66107f77DEb0F6Ca',
  treasury: '0x928b2B18a5d2622336F1b7c9Cf8dEff5D651E9bF',
  oracle: '0xB4644661d788C4bB1FF13C3EC22CCcdee36C5A37',
  robin: '0x31359C4eFaa272C78fC1e08F49d9A59dc510aEbA',
};

const inverseBondAbi = [
  'function capacityRaw() view returns (uint256)',
  'function price() view returns (uint256)',
  'function usdgWadFactor() view returns (uint256)',
  'function deposit(uint256 robinAmount, uint256 minUsdgRaw) returns (uint256 usdgRaw)',
];
const treasuryAbi = ['function backingPerToken() view returns (uint256)'];
const oracleAbi = [
  'function twapRobinUsdg() view returns (uint256)',
  'function lastCheckpointAt() view returns (uint64)',
  'function checkpoint()',
];
const erc20Abi = ['function balanceOf(address) view returns (uint256)'];

// ---------- Config (.env) ----------
let cfg;
try {
  cfg = {
    rpcUrl: process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com',
    // Endpoint séquenceur DIRECT (istio-envoy, sans Cloudflare) — accepte eth_sendRawTransaction.
    // On lit via le RPC, mais on DIFFUSE les tx ici pour couper la latence.
    sequencerUrl: process.env.SEQUENCER_URL || 'https://sequencer.mainnet.chain.robinhood.com',
    dryRun: (process.env.DRY_RUN ?? 'true').trim().toLowerCase() !== 'false',
    minPriceWad: ethers.parseUnits((process.env.MIN_PRICE_USDG || '0').trim(), 18),
    maxRobinPerTx: ethers.parseUnits((process.env.MAX_ROBIN_PER_TX || '0').trim(), ROBIN_DECIMALS),
    slippageBps: BigInt((process.env.SLIPPAGE_BPS || '50').trim()),
    pollMs: Math.max(200, Number(process.env.POLL_MS || 3000)),
    pollFastMs: Math.max(100, Number(process.env.POLL_FAST_MS || 400)),
    keepOracleAlive: (process.env.KEEP_ORACLE_ALIVE || 'false').trim().toLowerCase() === 'true',
    // --- mode SNIPE ---
    snipe: (process.env.SNIPE || 'false').trim().toLowerCase() === 'true',
    snipeLadder: (process.env.SNIPE_LADDER_ROBIN || '28,20,12,6')
      .split(',').map((s) => s.trim()).filter(Boolean)
      .map((s) => ethers.parseUnits(s, ROBIN_DECIMALS)).filter((a) => a > 0n),
    snipePresignMs: Math.max(200, Number(process.env.SNIPE_PRESIGN_MS || 1200)),
    snipeOffsetMs: Number(process.env.SNIPE_OFFSET_MS || 30),
    snipeFeeMult: Math.max(1, Number(process.env.SNIPE_FEE_MULT || 2)),
    snipeMopupMs: Math.max(0, Number(process.env.SNIPE_MOPUP_MS || 8000)),
    snipeUseRpcClock: (process.env.SNIPE_USE_RPC_CLOCK || 'false').trim().toLowerCase() === 'true',
    snipeMinZero: (process.env.SNIPE_MIN_ZERO || 'false').trim().toLowerCase() === 'true',
  };
} catch (e) {
  console.error('Config .env invalide:', e.message);
  process.exit(1);
}
if (cfg.slippageBps < 0n || cfg.slippageBps >= BPS) {
  console.error('SLIPPAGE_BPS doit être compris entre 0 et 9999');
  process.exit(1);
}
if (cfg.snipe && cfg.snipeLadder.length === 0) {
  console.error('SNIPE=true mais SNIPE_LADDER_ROBIN est vide.');
  process.exit(1);
}

// ---------- Helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Math.floor(Date.now() / 1000);
const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (...args) => console.log(`[${ts()}]`, ...args);
const errMsg = (e) => (e?.shortMessage || e?.message || String(e)).split('\n')[0].slice(0, 220);

function fmt(v, decimals, dp = 4) {
  const [int, frac = ''] = ethers.formatUnits(v, decimals).split('.');
  return dp > 0 ? `${int}.${(frac + '0'.repeat(dp)).slice(0, dp)}` : int;
}
const pct = (num, den) => (den > 0n ? `${(Number((num * 10_000n) / den) / 100).toFixed(2)}%` : 'n/a');

function withTimeout(promise, ms, label) {
  let timer;
  const gate = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: timeout après ${ms} ms`)), ms);
  });
  return Promise.race([promise, gate]).finally(() => clearTimeout(timer));
}

// Fenêtre rapide autour d'une borne d'epoch: de T-20 s à T+10 s.
function fastWindow(t) {
  const into = t % EPOCH_LEN;
  if (into <= 10) return t - into;
  if (EPOCH_LEN - into <= 20) return t + (EPOCH_LEN - into);
  return 0;
}

// ---------- Provider / wallet / contrats ----------
const provider = new ethers.JsonRpcProvider(cfg.rpcUrl, Number(CHAIN_ID), { staticNetwork: true });

const rawKey = (process.env.PRIVATE_KEY || '').trim();
let wallet;
if (rawKey) {
  wallet = new ethers.Wallet(rawKey, provider);
} else if (cfg.dryRun) {
  wallet = ethers.Wallet.createRandom().connect(provider);
} else {
  console.error('PRIVATE_KEY manquante dans .env — obligatoire quand DRY_RUN=false.');
  process.exit(1);
}

const inverseBond = new ethers.Contract(ADDR.inverseBond, inverseBondAbi, wallet);
const treasury = new ethers.Contract(ADDR.treasury, treasuryAbi, provider);
const oracle = new ethers.Contract(ADDR.oracle, oracleAbi, wallet);
const robin = new ethers.Contract(ADDR.robin, erc20Abi, provider);

// ---------- État ----------
let usdgWadFactor = 10n ** 12n; // relu on-chain au démarrage
let lastEpoch = -1;
let twapWasOk = true;
let depositInFlight = false;
let checkpointInFlight = false;
let lastCheckpointActionAt = 0;
let consecutiveFailures = 0;
let cooldownUntil = 0;
let lastDryLogAt = 0;
let clockSkewMs = 0; // (heure réelle − heure locale) estimée; appliqué seulement si SNIPE_USE_RPC_CLOCK

// Cache de course (fenêtre rapide POLL)
let raceKey = 0;
let raceTicks = 0;
let cachedNonce = null;
let cachedFees = null;
let snapshot = null;
let snapshotAt = 0;
let snapshotRefreshing = false;

// État SNIPE
let snipePhase = 'idle'; // idle | armed | fired — bloque les dépôts POLL pendant 'armed'
let snipeState = null;

const chainNow = () => Date.now() + (cfg.snipeUseRpcClock ? clockSkewMs : 0);

// Même arithmétique (divisions entières) que le contrat
const usdgRawFor = (robinAmount, price) => (robinAmount * price / ROBIN_UNIT) / usdgWadFactor;

function noteEpoch(t) {
  const epoch = Math.floor(t / EPOCH_LEN);
  if (epoch !== lastEpoch) {
    if (lastEpoch !== -1) log(`═══════ 🕗 NOUVELLE EPOCH ${epoch} — la capacité vient d'être renouvelée ═══════`);
    lastEpoch = epoch;
  }
  return epoch;
}

// ---------- Snapshot & pré-chargement (POLL) ----------
async function refreshSnapshot() {
  if (snapshotRefreshing) return;
  snapshotRefreshing = true;
  try {
    const [price, backing, balance, twapRes] = await Promise.all([
      inverseBond.price(),
      treasury.backingPerToken(),
      robin.balanceOf(wallet.address),
      oracle.twapRobinUsdg().then((value) => ({ ok: true, value })).catch(() => ({ ok: false })),
    ]);
    snapshot = { price, backing, balance, twapOk: twapRes.ok, twap: twapRes.ok ? twapRes.value : 0n };
    snapshotAt = Date.now();
  } catch (e) {
    log(`⚠️ refresh snapshot: ${errMsg(e)}`);
  } finally {
    snapshotRefreshing = false;
  }
}

async function prefetchRace() {
  try {
    const [nonce, fees] = await Promise.all([wallet.getNonce('pending'), provider.getFeeData()]);
    cachedNonce = nonce;
    cachedFees = fees;
    log(`   ⚡ pré-chargé: nonce ${nonce}, frais de gas prêts — envoi direct sans aller-retour RPC`);
  } catch (e) {
    log(`⚠️ prefetch course: ${errMsg(e)}`);
  }
}

function txOverrides() {
  const o = { gasLimit: GAS_LIMIT };
  if (cachedNonce != null) o.nonce = cachedNonce;
  if (cachedFees?.maxFeePerGas) {
    o.maxFeePerGas = cachedFees.maxFeePerGas * 2n;
    o.maxPriorityFeePerGas = cachedFees.maxPriorityFeePerGas ?? 0n;
  } else if (cachedFees?.gasPrice) {
    o.gasPrice = cachedFees.gasPrice * 2n;
  }
  return o;
}

// ---------- Transactions POLL ----------
async function sendDeposit(amount, minUsdgRaw, expected, overrides) {
  depositInFlight = true;
  const usedCachedNonce = overrides.nonce != null;
  try {
    const tx = await inverseBond.deposit(amount, minUsdgRaw, overrides);
    log(`   ↗ tx envoyée: ${tx.hash}`);
    const rcpt = await tx.wait(1, 180_000);
    consecutiveFailures = 0;
    if (usedCachedNonce) cachedNonce = overrides.nonce + 1;
    if (snapshot) snapshot.balance = snapshot.balance >= amount ? snapshot.balance - amount : 0n;
    log(`   ✅ CONFIRMÉE bloc ${rcpt.blockNumber} — ${fmt(amount, ROBIN_DECIMALS)} ROBIN → ~${fmt(expected, USDG_DECIMALS)} USDG (gas ${rcpt.gasUsed})`);
    refreshSnapshot().catch(() => {});
  } catch (e) {
    consecutiveFailures += 1;
    if (e?.code === 'CALL_EXCEPTION' && e?.receipt) {
      if (usedCachedNonce) cachedNonce = overrides.nonce + 1;
      log(`   ❌ REVERT on-chain bloc ${e.receipt.blockNumber} — capacité probablement prise par un concurrent`);
    } else {
      if (usedCachedNonce) cachedNonce = null;
      log(`   ❌ échec deposit: ${errMsg(e)}`);
    }
    if (consecutiveFailures >= 3) {
      cooldownUntil = Date.now() + 60_000;
      consecutiveFailures = 0;
      log('   ⏸ 3 échecs consécutifs — pause de 60 s sur les dépôts');
    }
  } finally {
    depositInFlight = false;
  }
}

async function sendCheckpoint(age) {
  checkpointInFlight = true;
  lastCheckpointActionAt = Date.now();
  try {
    log(`   dernier checkpoint il y a ${age} s → envoi de oracle.checkpoint()`);
    const tx = await oracle.checkpoint();
    log(`   ↗ checkpoint envoyé: ${tx.hash}`);
    const rcpt = await tx.wait(1, 180_000);
    log(`   ✅ checkpoint confirmé bloc ${rcpt.blockNumber} — TWAP lisible dans ~30 min`);
  } catch (e) {
    log(`   ❌ échec checkpoint: ${errMsg(e)}`);
  } finally {
    checkpointInFlight = false;
  }
}

// Décision de dépôt POLL. Renvoie true si un dépôt a été déclenché.
function tryDeposit({ capacity, price, backing, balance, twapOk, twap }, overrides) {
  if (cfg.snipe && snipePhase === 'armed') return false; // le SNIPE possède la borne
  const open = twapOk && twap < backing;
  if (!open || capacity === 0n || balance === 0n || price === 0n) return false;
  if (cfg.minPriceWad > 0n && price < cfg.minPriceWad) return false;
  if (depositInFlight || Date.now() < cooldownUntil) return false;

  let amount = (capacity * usdgWadFactor * ROBIN_UNIT) / price;
  while (amount > 0n && usdgRawFor(amount, price) > capacity) amount -= 1n;
  if (amount > balance) amount = balance;
  if (cfg.maxRobinPerTx > 0n && amount > cfg.maxRobinPerTx) amount = cfg.maxRobinPerTx;

  const expected = usdgRawFor(amount, price);
  if (amount === 0n || expected === 0n) return false;
  const minUsdgRaw = (expected * (BPS - cfg.slippageBps)) / BPS;

  if (cfg.dryRun) {
    if (Date.now() - lastDryLogAt > 2000) {
      log(`💰 dépôt ${fmt(amount, ROBIN_DECIMALS)} ROBIN → ~${fmt(expected, USDG_DECIMALS)} USDG (min ${fmt(minUsdgRaw, USDG_DECIMALS)}, slippage ${cfg.slippageBps} bps)`);
      log('   DRY_RUN=true — transaction NON envoyée');
      lastDryLogAt = Date.now();
    }
    return true;
  }

  log(`💰 dépôt ${fmt(amount, ROBIN_DECIMALS)} ROBIN → ~${fmt(expected, USDG_DECIMALS)} USDG (min ${fmt(minUsdgRaw, USDG_DECIMALS)}, slippage ${cfg.slippageBps} bps)`);
  sendDeposit(amount, minUsdgRaw, expected, overrides).catch(() => {});
  return true;
}

// ---------- SNIPE: horloge, armement, tir ----------
// Estime le décalage (heure réelle − horloge locale) via l'en-tête HTTP Date du RPC.
// Résolution ~1 s: utile pour DÉTECTER une grosse dérive, pas pour un timing fin.
async function measureClockSkew() {
  const samples = [];
  for (let i = 0; i < 4; i++) {
    try {
      const t0 = Date.now();
      const r = await fetch(cfg.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      });
      const t1 = Date.now();
      const d = r.headers.get('date');
      if (d) {
        const server = Date.parse(d);
        samples.push(server + (t1 - t0) / 2 - t1); // skew ≈ heureServeur − heureLocale (corrigé du RTT/2)
      }
    } catch { /* ignore */ }
    await sleep(120);
  }
  if (samples.length) {
    samples.sort((a, b) => a - b);
    clockSkewMs = Math.round(samples[Math.floor(samples.length / 2)]); // médiane
  }
  return samples.length;
}

// Pré-signe l'échelle de transactions (montants décroissants, nonces séquentiels) pour la borne.
async function armSnipe(boundarySec) {
  const [price, backing, balance, nonce, fees, twapRes] = await Promise.all([
    inverseBond.price(),
    treasury.backingPerToken(),
    robin.balanceOf(wallet.address),
    wallet.getNonce('pending'),
    provider.getFeeData(),
    oracle.twapRobinUsdg().then((value) => ({ ok: true, value })).catch(() => ({ ok: false })),
  ]);

  if (balance === 0n) { log('   SNIPE: solde ROBIN nul — rien à armer.'); snipeState = null; return; }
  if (price === 0n) { log('   SNIPE: price() = 0 — armement annulé.'); snipeState = null; return; }
  if (twapRes.ok && twapRes.value >= backing) {
    log(`   SNIPE: marché FERMÉ à l'armement (twap ${fmt(twapRes.value, 18, 6)} ≥ backing ${fmt(backing, 18, 6)}) — deposit reverterait, on n'arme pas.`);
    snipeState = null;
    return;
  }

  const base = fees.maxFeePerGas ?? fees.gasPrice ?? 0n;
  const maxFee = (base * BigInt(Math.round(cfg.snipeFeeMult * 100))) / 100n;
  const prio = fees.maxPriorityFeePerGas ?? 0n;

  const plan = [];
  let n = nonce;
  for (const rung of cfg.snipeLadder) {
    let amt = rung;
    if (cfg.maxRobinPerTx > 0n && amt > cfg.maxRobinPerTx) amt = cfg.maxRobinPerTx;
    if (amt > balance) amt = balance; // aucune tx ne peut brûler plus que le solde
    if (amt <= 0n) continue;
    const expected = usdgRawFor(amt, price);
    if (expected === 0n) continue;
    const minU = cfg.snipeMinZero ? 0n : (expected * (BPS - cfg.slippageBps)) / BPS;
    const data = inverseBond.interface.encodeFunctionData('deposit', [amt, minU]);
    const raw = await wallet.signTransaction({
      to: ADDR.inverseBond, data, value: 0n, nonce: n, gasLimit: GAS_LIMIT,
      maxFeePerGas: maxFee, maxPriorityFeePerGas: prio, type: 2, chainId: Number(CHAIN_ID),
    });
    plan.push({ nonce: n, amt, minU, expected, raw });
    n += 1;
  }

  if (plan.length === 0) { log('   SNIPE: aucune tranche valide à signer.'); snipeState = null; return; }
  snipeState = { boundary: boundarySec, plan, fired: false };
  log(`   🎯 SNIPE armé pour ${new Date(boundarySec * 1000).toISOString().slice(11, 19)} UTC — ${plan.length} tx pré-signées, nonces ${plan[0].nonce}..${plan[plan.length - 1].nonce}`);
  log(`      échelle: ${plan.map((x) => fmt(x.amt, ROBIN_DECIMALS, 0)).join(' → ')} ROBIN | maxFee ${fmt(maxFee, 9, 3)} gwei (x${cfg.snipeFeeMult}) | prix ${fmt(price, 18, 6)}`);
  warmSequencer(); // ouvre/garde chaude la connexion TLS au séquenceur pour le tir
}

// Ouvre (et garde chaude) une connexion au séquenceur pour éviter de payer le
// handshake TCP/TLS au moment du tir. La réponse importe peu (le séquenceur peut
// rejeter la méthode): seul le fait d'établir la connexion compte. fetch de Node
// réutilise ensuite cette connexion du pool keep-alive pour l'envoi de la tx.
async function warmSequencer() {
  try {
    await fetch(cfg.sequencerUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', connection: 'keep-alive' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'net_version', params: [] }),
    });
  } catch { /* on veut juste établir/garder la connexion, l'erreur est sans importance */ }
}

// Diffuse un raw signé via l'endpoint séquenceur DIRECT (chemin le plus court).
// Repli sur le RPC standard en cas d'erreur réseau (pas sur un rejet de validation).
async function sendRawFast(raw) {
  try {
    const r = await fetch(cfg.sequencerUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [raw] }),
    });
    const j = await r.json();
    if (j?.result) return { hash: j.result, via: 'sequenceur' };
    if (j?.error) throw new Error(`seq:${j.error.message || JSON.stringify(j.error)}`);
    throw new Error('seq:réponse inattendue');
  } catch (e) {
    if (String(e.message).startsWith('seq:')) throw new Error(String(e.message).slice(4)); // rejet de validation → pas de repli
    const resp = await provider.broadcastTransaction(raw); // repli RPC (erreur réseau)
    return { hash: resp.hash, via: 'rpc(repli)' };
  }
}

// Diffuse toutes les tx pré-signées en parallèle, à l'instant du tir.
async function fireSnipe() {
  const s = snipeState;
  if (!s || s.fired) return;
  s.fired = true;
  log(`🚀 SNIPE FEU — diffusion de ${s.plan.length} tx pré-signées via ${cfg.sequencerUrl} (borne ${new Date(s.boundary * 1000).toISOString().slice(11, 19)} UTC)`);

  if (cfg.dryRun) {
    for (const x of s.plan) {
      log(`   DRY_RUN: nonce ${x.nonce} deposit(${fmt(x.amt, ROBIN_DECIMALS, 0)} ROBIN, min ${fmt(x.minU, USDG_DECIMALS)}) → ~${fmt(x.expected, USDG_DECIMALS)} USDG — NON diffusée`);
    }
    cachedNonce = null;
    return;
  }

  const results = await Promise.allSettled(s.plan.map((x) => sendRawFast(x.raw)));
  results.forEach((r, i) => {
    const x = s.plan[i];
    if (r.status === 'fulfilled') {
      log(`   ↗ nonce ${x.nonce} (${fmt(x.amt, ROBIN_DECIMALS, 0)} ROBIN) diffusée [${r.value.via}]: ${r.value.hash}`);
      provider.waitForTransaction(r.value.hash, 1, 120_000)
        .then((rc) => log(`   ${rc && rc.status === 1 ? '✅ CONFIRMÉE' : '❌ REVERT'} nonce ${x.nonce} bloc ${rc?.blockNumber} — ${fmt(x.amt, ROBIN_DECIMALS, 0)} ROBIN`))
        .catch((e) => log(`   ⚠️ suivi nonce ${x.nonce}: ${errMsg(e)}`));
    } else {
      log(`   ⚠️ nonce ${x.nonce} rejetée à l'envoi: ${errMsg(r.reason)}`);
    }
  });
  cachedNonce = null; // le POLL de nettoyage relira le nonce
}

// Planificateur SNIPE: arme à T-presign, tire à T+offset, laisse le POLL nettoyer, recommence.
async function snipeScheduler() {
  while (true) {
    const nextBoundary = (Math.floor(chainNow() / 1000 / EPOCH_LEN) + 1) * EPOCH_LEN;
    const boundaryMs = nextBoundary * 1000;

    await sleep(Math.max(0, (boundaryMs - cfg.snipePresignMs) - chainNow()));
    snipePhase = 'armed';
    try { await armSnipe(nextBoundary); } catch (e) { log(`⚠️ SNIPE arm: ${errMsg(e)}`); }

    await sleep(Math.max(0, (boundaryMs + cfg.snipeOffsetMs) - chainNow()));
    try { await fireSnipe(); } catch (e) { log(`⚠️ SNIPE feu: ${errMsg(e)}`); }

    snipePhase = 'fired'; // le POLL peut désormais nettoyer les restes
    await sleep(Math.max(1500, cfg.snipeMopupMs) + 1500);
    snipePhase = 'idle';
    snipeState = null;
  }
}

// ---------- Tick normal POLL (hors fenêtre rapide) ----------
async function tick() {
  const t = now();
  const epoch = noteEpoch(t);
  const toNext = EPOCH_LEN - (t % EPOCH_LEN);

  const [capacity, price, backing, balance, twapRes] = await withTimeout(
    Promise.all([
      inverseBond.capacityRaw(),
      inverseBond.price(),
      treasury.backingPerToken(),
      robin.balanceOf(wallet.address),
      oracle.twapRobinUsdg().then((value) => ({ ok: true, value })).catch((err) => ({ ok: false, err })),
    ]),
    15_000,
    'lecture RPC'
  );

  const open = twapRes.ok && twapRes.value < backing;
  const robinCap = price > 0n ? (capacity * usdgWadFactor * ROBIN_UNIT) / price : 0n;
  const state = !twapRes.ok ? '⚠️ TWAP INDISPO' : open ? '🟢 OUVERT' : '🔴 FERMÉ';

  log(
    `epoch ${epoch} | T-${toNext}s | ${state} | capacité ${fmt(capacity, USDG_DECIMALS, 2)} USDG (≈ ${fmt(robinCap, ROBIN_DECIMALS, 2)} ROBIN)` +
      ` | prix ${fmt(price, 18, 6)} | backing ${fmt(backing, 18, 6)}` +
      ` | twap ${twapRes.ok ? `${fmt(twapRes.value, 18, 6)} (${pct(twapRes.value, backing)} du backing)` : 'revert'}` +
      ` | solde ${fmt(balance, ROBIN_DECIMALS, 2)} ROBIN`
  );

  if (!twapRes.ok) {
    if (twapWasOk) {
      log(`   raison: ${errMsg(twapRes.err)}`);
      twapWasOk = false;
    }
    if (cfg.keepOracleAlive && !checkpointInFlight && Date.now() - lastCheckpointActionAt > 5 * 60_000) {
      const last = await oracle.lastCheckpointAt();
      const age = BigInt(t) - last;
      if (age > 1800n) {
        if (cfg.dryRun) {
          log(`   DRY_RUN: oracle.checkpoint() serait envoyé (dernier checkpoint il y a ${age} s)`);
          lastCheckpointActionAt = Date.now();
        } else {
          sendCheckpoint(age).catch(() => {});
        }
      } else {
        log(`   checkpoint récent (${age} s) — TWAP lisible dans ~${1800n - age} s`);
        lastCheckpointActionAt = Date.now();
      }
    }
    return;
  }
  if (!twapWasOk) {
    log('   TWAP de nouveau disponible ✓');
    twapWasOk = true;
  }

  tryDeposit({ capacity, price, backing, balance, twapOk: twapRes.ok, twap: twapRes.value }, { gasLimit: GAS_LIMIT });
}

// ---------- Tick de course POLL (fenêtre rapide) ----------
async function raceTick(boundaryTs) {
  if (raceKey !== boundaryTs) {
    raceKey = boundaryTs;
    raceTicks = 0;
    log(`⚡ fenêtre rapide POLL (${cfg.pollFastMs} ms) — borne d'epoch à ${new Date(boundaryTs * 1000).toISOString().slice(11, 19)} UTC`);
    prefetchRace().catch(() => {});
    refreshSnapshot().catch(() => {});
  }
  raceTicks += 1;

  if (Date.now() - snapshotAt > 2000) refreshSnapshot().catch(() => {});
  if (!cfg.dryRun && cachedNonce == null && !depositInFlight) {
    try { cachedNonce = await wallet.getNonce('pending'); } catch { /* retenté */ }
  }

  noteEpoch(now());
  const capacity = await withTimeout(inverseBond.capacityRaw(), 10_000, 'capacityRaw');
  const t = now();
  const into = t % EPOCH_LEN;
  const lbl = into <= 10 ? `T+${into}s` : `T-${EPOCH_LEN - into}s`;

  let fired = false;
  if (capacity > 0n && snapshot) {
    fired = tryDeposit({ capacity, ...snapshot }, txOverrides());
  }
  if (!fired && raceTicks % 10 === 1) {
    const etat = !snapshot ? 'snapshot…' : !snapshot.twapOk ? 'TWAP indispo' : snapshot.twap < snapshot.backing ? 'OUVERT' : 'FERMÉ';
    log(`   course ${lbl} | capacité ${fmt(capacity, USDG_DECIMALS, 2)} USDG | ${etat}${cfg.snipe && snipePhase === 'armed' ? ' | (SNIPE armé)' : ''}`);
  }
}

async function pollLoop() {
  while (true) {
    const started = Date.now();
    try {
      const key = fastWindow(now());
      if (key !== 0) {
        await raceTick(key);
      } else {
        if (raceKey !== 0) {
          raceKey = 0;
          cachedNonce = null;
          cachedFees = null;
          snapshot = null;
        }
        await tick();
      }
    } catch (e) {
      log(`⚠️ erreur: ${errMsg(e)}`);
    }
    const interval = fastWindow(now()) !== 0 ? cfg.pollFastMs : cfg.pollMs;
    await sleep(Math.max(interval - (Date.now() - started), 25));
  }
}

async function main() {
  log('🤖 Bot de rachat ROBIN via InverseBond — démarrage (heures en UTC)');
  log(`   mode: ${cfg.dryRun ? 'DRY_RUN (aucune transaction ne sera envoyée)' : '🔥 LIVE — les dépôts seront envoyés'}`);
  log(`   wallet: ${wallet.address}${rawKey ? '' : ' (clé factice aléatoire — PRIVATE_KEY absente)'}`);
  log(`   rpc: ${cfg.rpcUrl}`);
  log(`   POLL: ${cfg.pollMs} ms — course ${cfg.pollFastMs} ms de T-20 s à T+10 s (nettoyage des restes)`);
  if (cfg.snipe) {
    log(`   SNIPE: ✅ ACTIF — pré-signe à T-${cfg.snipePresignMs} ms, tire à T+${cfg.snipeOffsetMs} ms`);
    log(`          échelle ${cfg.snipeLadder.map((a) => fmt(a, ROBIN_DECIMALS, 0)).join('/')} ROBIN | feeMult x${cfg.snipeFeeMult} | minUsdg ${cfg.snipeMinZero ? '0 (aucun)' : `slippage ${cfg.slippageBps} bps`}`);
    log(`          diffusion via séquenceur direct: ${cfg.sequencerUrl}`);
  } else {
    log('   SNIPE: désactivé (SNIPE=true pour l’activer)');
  }
  log(`   slippage: ${cfg.slippageBps} bps | plancher: ${cfg.minPriceWad > 0n ? `${fmt(cfg.minPriceWad, 18, 6)} USDG/ROBIN` : 'aucun'} | max/tx: ${cfg.maxRobinPerTx > 0n ? `${fmt(cfg.maxRobinPerTx, ROBIN_DECIMALS, 2)} ROBIN` : 'illimité'}`);
  log('   (prix, backing et twap sont exprimés en USDG par ROBIN)');

  const chainIdHex = await withTimeout(provider.send('eth_chainId', []), 15_000, 'eth_chainId');
  const chainId = BigInt(chainIdHex);
  if (chainId !== CHAIN_ID) {
    log(`⚠️ chainId renvoyé par le RPC: ${chainId}, attendu: ${CHAIN_ID}`);
    if (!cfg.dryRun) { log('Arrêt: mode LIVE sur une mauvaise chaîne.'); process.exit(1); }
  } else {
    log(`   chainId vérifié: ${chainId} ✓`);
  }

  usdgWadFactor = await withTimeout(inverseBond.usdgWadFactor(), 15_000, 'usdgWadFactor');
  log(`   usdgWadFactor: ${usdgWadFactor} ✓`);

  if (cfg.snipe) {
    const n = await measureClockSkew();
    if (n) {
      log(`   ⏱ décalage horloge locale vs RPC estimé: ${clockSkewMs} ms (résolution ~1 s) — ${cfg.snipeUseRpcClock ? 'APPLIQUÉ' : 'non appliqué; règle SNIPE_OFFSET_MS à la main'}`);
      if (Math.abs(clockSkewMs) > 1500 && !cfg.snipeUseRpcClock) {
        log('   ⚠️ horloge probablement désynchronisée de >1,5 s — active la synchro Windows (w32tm) ou mets SNIPE_USE_RPC_CLOCK=true');
      }
    } else {
      log('   ⏱ décalage horloge: non mesurable (en-tête Date absent) — repose sur l’horloge de l’OS');
    }
  }

  log('── boucle de surveillance ──');
  const loops = [pollLoop()];
  if (cfg.snipe) loops.push(snipeScheduler());
  await Promise.all(loops);
}

process.on('SIGINT', () => {
  log('⏹ arrêt du bot');
  process.exit(0);
});

main().catch((e) => {
  log(`💥 erreur fatale: ${errMsg(e)}`);
  process.exit(1);
});
