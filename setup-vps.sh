#!/usr/bin/env bash
# setup-vps.sh — installe le bot ROBIN sur un serveur Ubuntu (Vultr us/Chicago).
# A lancer en root, dans le dossier ou se trouvent bot.js et package.json.
# Il N'INSTALLE PAS ta cle: tu la mettras toi-meme dans /opt/robin-bot/.env.
set -euo pipefail

APP_DIR=/opt/robin-bot
SEQ_URL=https://sequencer.mainnet.chain.robinhood.com
SRC="$(cd "$(dirname "$0")" && pwd)"

echo "==> 1/6 Verification root"
if [ "$(id -u)" -ne 0 ]; then echo "Lance en root (sudo)."; exit 1; fi
if [ ! -f "$SRC/bot.js" ] || [ ! -f "$SRC/package.json" ]; then
  echo "bot.js / package.json introuvables dans $SRC — copie-les d'abord (scp)."; exit 1
fi

echo "==> 2/6 Installation de Node.js 22 LTS + git"
apt-get update -y
apt-get install -y curl ca-certificates git
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
echo "    node $(node --version) / npm $(npm --version)"

echo "==> 3/6 Mise en place du bot dans $APP_DIR"
mkdir -p "$APP_DIR"
cp "$SRC/bot.js" "$SRC/package.json" "$APP_DIR/"
cd "$APP_DIR"
npm install --omit=dev --no-audit --no-fund

echo "==> 4/6 Fichier .env (cree seulement s'il n'existe pas ; SANS ta cle)"
if [ ! -f "$APP_DIR/.env" ]; then
  cat > "$APP_DIR/.env" <<ENV
# METS TA CLE ICI puis passe DRY_RUN=false quand tu es pret.
PRIVATE_KEY=
RPC_URL=https://rpc.mainnet.chain.robinhood.com
SEQUENCER_URL=$SEQ_URL
DRY_RUN=true
MIN_PRICE_USDG=5
MAX_ROBIN_PER_TX=0
SLIPPAGE_BPS=50
POLL_MS=3000
POLL_FAST_MS=150
KEEP_ORACLE_ALIVE=false
SNIPE=true
SNIPE_LADDER_ROBIN=28,20,12,6
SNIPE_PRESIGN_MS=1200
SNIPE_OFFSET_MS=30
SNIPE_FEE_MULT=2
SNIPE_MOPUP_MS=8000
SNIPE_MIN_ZERO=false
SNIPE_USE_RPC_CLOCK=false
ENV
  chmod 600 "$APP_DIR/.env"
  echo "    .env cree (DRY_RUN=true, PRIVATE_KEY vide)"
else
  echo "    .env existe deja — inchange"
fi

echo "==> 5/6 Service systemd robin-bot (pas demarre)"
cat > /etc/systemd/system/robin-bot.service <<UNIT
[Unit]
Description=Bot de rachat ROBIN InverseBond
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/node $APP_DIR/bot.js
Restart=always
RestartSec=3
User=root

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
echo "    service installe (lancement manuel plus bas)"

echo "==> 6/6 Test de latence vers le sequenceur (Chicago -> Ohio)"
LAT=$(curl -s -o /dev/null -w "%{time_total}" -X POST -H "content-type: application/json" \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_sendRawTransaction","params":["0x"]}' "$SEQ_URL" || echo "n/a")
echo "    latence aller-retour: ${LAT}s  (vise < 0.020s ; chez toi c'etait ~0.30s)"

cat <<'NEXT'

================= INSTALLATION TERMINEE =================
Il reste 2 choses A FAIRE TOI-MEME:

  1) Mettre ta cle privee et activer le mode reel:
       nano /opt/robin-bot/.env
     - colle ta cle sur la ligne PRIVATE_KEY=
     - quand tu es pret a trader pour de vrai: DRY_RUN=false
     (Ctrl+O pour sauver, Ctrl+X pour quitter)

  2) Demarrer le bot 24/7 et voir les logs:
       systemctl enable --now robin-bot
       journalctl -u robin-bot -f     (Ctrl+C pour arreter de regarder)

  Commandes utiles:
       systemctl restart robin-bot     # apres avoir modifie .env
       systemctl stop robin-bot        # arreter le bot
       systemctl status robin-bot      # etat
========================================================
NEXT
