#!/usr/bin/env bash
# setup-v2.sh — installe une SECONDE instance du bot, pointee sur les contrats V2,
# a cote de l'instance V1 existante (qui n'est pas touchee).
#
# Prerequis: le bot V1 est deja installe dans /opt/robin-bot.
# A lancer en root depuis le depot clone (/root/robin-src).
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
APP=/opt/robin-bot-v2
V1=/opt/robin-bot

echo "==> 1/5 Verifications"
if [ "$(id -u)" -ne 0 ]; then echo "Lance en root."; exit 1; fi
if [ ! -f "$SRC/bot.js" ]; then echo "bot.js introuvable dans $SRC"; exit 1; fi
if [ ! -d "$V1" ]; then echo "ATTENTION: $V1 absent (instance V1 non trouvee) - on continue quand meme"; fi

echo "==> 2/5 Mise en place dans $APP"
mkdir -p "$APP"
cp "$SRC/bot.js" "$SRC/package.json" "$APP/"
cd "$APP"
npm install --omit=dev --no-audit --no-fund

echo "==> 3/5 Fichier .env V2 (cree seulement s'il n'existe pas ; SANS ta cle)"
if [ ! -f "$APP/.env" ]; then
  cp "$SRC/.env.v2.example" "$APP/.env"
  chmod 600 "$APP/.env"
  echo "    .env cree depuis .env.v2.example (DRY_RUN=true, PRIVATE_KEY vide)"
else
  echo "    .env existe deja - inchange"
fi

echo "==> 4/5 Service systemd robin-bot-v2 (pas demarre)"
cat > /etc/systemd/system/robin-bot-v2.service <<UNIT
[Unit]
Description=Bot de rachat ROBIN V2 InverseBond
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP
ExecStart=/usr/bin/node $APP/bot.js
Restart=always
RestartSec=3
User=root

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
echo "    service robin-bot-v2 installe"

echo "==> 5/5 Etat du marche V2"
node --input-type=module -e "
import { ethers } from 'ethers';
const p=new ethers.JsonRpcProvider('https://rpc.mainnet.chain.robinhood.com',4663,{staticNetwork:true});
const ib=new ethers.Contract('0xCe4FDa6De3D3D9B763856a0c93785ED98A1b58a1',['function capacityRaw() view returns(uint256)','function price() view returns(uint256)'],p);
const tr=new ethers.Contract('0x70d39473CD3342B75C57465aE32a0a427d537654',['function backingPerToken() view returns(uint256)'],p);
const or=new ethers.Contract('0xEa6a4F0F82163bcB3B0b71F94404c1d4122d3F45',['function twapRobinUsdg() view returns(uint256)'],p);
const [c,pr,b]=await Promise.all([ib.capacityRaw(),ib.price(),tr.backingPerToken()]);
let tw='indispo'; try{ tw=ethers.formatUnits(await or.twapRobinUsdg(),18).slice(0,7); }catch{}
console.log('    capacite:',ethers.formatUnits(c,6),'USDG | prix rachat:',ethers.formatUnits(pr,18).slice(0,7),'| backing:',ethers.formatUnits(b,18).slice(0,7),'| twap:',tw);
" || echo "    (lecture du marche impossible)"

cat <<'NEXT'

============ INSTANCE V2 INSTALLEE ============
Le bot V1 (/opt/robin-bot) n'a PAS ete touche.

A FAIRE TOI-MEME:
  1) Mettre ta NOUVELLE cle (differente de celle du V1 !):
       nano /opt/robin-bot-v2/.env
     - colle la cle sur PRIVATE_KEY=
     - laisse DRY_RUN=true pour un premier test

  2) Tester en simulation:
       cd /opt/robin-bot-v2 && timeout 20 node bot.js

  3) Quand c'est bon, passer DRY_RUN=false puis demarrer:
       systemctl enable --now robin-bot-v2
       journalctl -u robin-bot-v2 -f

COMMANDES UTILES (les deux bots sont independants):
  systemctl status robin-bot      # V1
  systemctl status robin-bot-v2   # V2
  journalctl -u robin-bot-v2 -f   # logs V2 uniquement
===============================================
NEXT
