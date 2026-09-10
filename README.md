# Bot de rachat ROBIN — InverseBond (Robinhood Chain)

Vend automatiquement vos ROBIN au contrat InverseBond au prix du backing (backing − 1,50 %) dès qu'il y a de la capacité, avec polling accéléré autour du renouvellement d'epoch (00:00, 08:00, 16:00 UTC — toutes les 8 h). Aucun `approve` nécessaire : le contrat brûle les ROBIN directement chez l'appelant.

## Installation

```bash
npm install
cp .env.example .env
```

Puis renseignez `PRIVATE_KEY` dans `.env` vous-même.

## Configuration (.env)

| Variable | Défaut | Rôle |
|---|---|---|
| `PRIVATE_KEY` | — | clé du wallet qui détient les ROBIN (jamais commitée) |
| `RPC_URL` | rpc.mainnet.chain.robinhood.com | RPC, chainId 4663 (vérifié au démarrage) |
| `DRY_RUN` | `true` | `true` = tout est loggé, aucune tx envoyée |
| `MIN_PRICE_USDG` | `0` | plancher de prix (USDG/ROBIN), 0 = désactivé |
| `MAX_ROBIN_PER_TX` | `0` | taille max par tx en ROBIN, 0 = illimité |
| `SLIPPAGE_BPS` | `50` | marge sur `minUsdgRaw` (50 = 0,50 %) |
| `POLL_MS` / `POLL_FAST_MS` | `3000` / `400` | cadence normale / rapide (de T-20 s à T+10 s autour des epochs) |
| `KEEP_ORACLE_ALIVE` | `false` | envoie `checkpoint()` si le TWAP est indisponible (coûte du gas) |

## Mode SNIPE (viser le premier bloc de l'epoch)

À chaque borne, la capacité se renouvelle **au premier bloc** de la nouvelle epoch, et les meilleurs concurrents y placent une transaction pré-signée déclenchée sur horloge — impossible à battre en lisant d'abord la capacité (le temps de la lire, leur tx est déjà dans le bloc). Le mode SNIPE réplique cette approche.

**Important — cette chaîne (Arbitrum Orbit) ordonne les tx par ordre d'ARRIVÉE au séquenceur, pas par prix du gas.** Vérifié on-chain : le gagnant d'un epoch avait payé le fee le plus élevé du bloc et était quand même en position #2. Monter les fees n'aide donc **pas** à passer devant — seule la **latence** compte. `SNIPE_FEE_MULT` ne sert qu'à garantir l'inclusion.

Fonctionnement : à `T-SNIPE_PRESIGN_MS`, le bot pré-signe une échelle de `deposit` (montants décroissants, nonces séquentiels) ; à `T+SNIPE_OFFSET_MS` (juste après la borne), il les diffuse toutes en parallèle sans rien lire. On ne connaît pas la capacité à l'avance : la première tranche qui « rentre » passe, les trop grosses revert (poussière de gas). Le polling continue en parallèle pour ramasser les restes.

| Variable | Défaut | Rôle |
|---|---|---|
| `SNIPE` | `false` | active le mode sniper |
| `SNIPE_LADDER_ROBIN` | `28,20,12,6` | montants décroissants (ROBIN), une tx pré-signée par tranche |
| `SNIPE_PRESIGN_MS` | `1200` | délai de pré-signature avant la borne |
| `SNIPE_OFFSET_MS` | `30` | décalage du tir après la borne (négatif = risque de revert dans le bloc d'avant) |
| `SNIPE_FEE_MULT` | `2` | multiplicateur des fees (inclusion seulement, ne réordonne pas) |
| `SNIPE_MOPUP_MS` | `8000` | fenêtre de nettoyage par le polling après le tir |
| `SNIPE_MIN_ZERO` | `false` | `true` = `minUsdgRaw=0` sur les tx snipe (retire une cause de revert) |
| `SNIPE_USE_RPC_CLOCK` | `false` | applique le décalage d'horloge mesuré via RPC (grossier, ~1 s) |

### Ce qui décide vraiment la course (vérifié on-chain + doc Robinhood)

- **Ordre = premier arrivé au séquenceur, PAS le prix du gas.** Confirmé on-chain (le gagnant d'un epoch payait le tip le plus élevé du bloc — 5 gwei — et était quand même en position #2, derrière une tx à 0 tip ; le tip n'est même pas facturé, tout le monde paie la baseFee) et par la doc officielle Robinhood. Monter les fees n'aide pas.
- **Timeboost (priorité payante) n'est pas activé** sur cette chaîne → impossible d'acheter l'ordre.
- **Le séquenceur est en AWS us-east-2 (Ohio).** Depuis une connexion résidentielle EU/Asie, la latence est ~270-300 ms ; le bloc n°1 est produit ~100 ms après la borne. Tu arrives donc structurellement trop tard. Un bot colocalisé en us-east-2 a ~1-5 ms — c'est comme ça que le gagnant rentre dans le 1er bloc.

**Pour être réellement compétitif :**
1. **Fais tourner le bot sur un VPS AWS us-east-2** (ou tout serveur proche d'Ohio). C'est le seul vrai levier : ça t'amène de ~270 ms à ~1-5 ms.
2. Le bot diffuse déjà via l'endpoint séquenceur direct `SEQUENCER_URL` (istio-envoy, sans Cloudflare) plutôt que le RPC public (proxifié, rate-limité, « not for latency-sensitive apps »).
3. Garde l'horloge synchronisée au VPS et affine `SNIPE_OFFSET_MS` (vise 0 à +30 ms).
4. Pour les LECTURES, prends un RPC dédié bas-latence (Alchemy/Quicknode/Chainstack) proche de us-east-2 plutôt que le RPC public.

**Honnêtement** : même colocalisé, tu ne « gagnes pas à 100 % » — tu passes de « structurellement perdant » à « à armes égales » avec l'autre bot, et la course se joue alors en microsecondes (connexion persistante, pré-signature). Bonne nouvelle : sur les dernières bornes analysées, le concurrent n'était présent qu'une fois sur six — la capacité est souvent peu/pas disputée, donc un simple VPS bien placé peut suffire à rafler la plupart des bornes. Cale `SNIPE_LADDER_ROBIN` sur la capacité réelle observée, surveille le gas (chaque revert en coûte un peu), et teste d'abord en `DRY_RUN=true`.

## Lancement

```bash
npm start
```

À chaque tick, le bot lit en parallèle capacité, prix, backing, TWAP et solde, puis dépose si : TWAP < backing, capacité > 0, solde > 0 et prix ≥ plancher. Le montant consomme la capacité (arithmétique en divisions entières identique au contrat), borné par le solde et `MAX_ROBIN_PER_TX`. Le `deposit` part avec `gasLimit` 400 000 (pas d'`estimateGas`, pour la vitesse).

## Avertissements

- `DRY_RUN=true` par défaut. Passez à `false` seulement quand le wallet a des ROBIN et du gas natif.
- Concurrence entre bots au changement d'epoch : une tx peut revert si la capacité est déjà prise (gas perdu). Après 3 échecs consécutifs, le bot fait une pause de 60 s.
- Ne partagez jamais votre clé privée. `.env` est dans `.gitignore`.
