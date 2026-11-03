#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
WRANGLER="node node_modules/wrangler/bin/wrangler.js"
CONFIG="wrangler.auth-check.jsonc"
echo 'Configuration du Worker OAuth ChatGPT dédié (aucune valeur ne sera affichée).'
echo '1/3 : colle le Client ID Google Web (se termine par .apps.googleusercontent.com)'
$WRANGLER secret put GOOGLE_OAUTH_WEB_CLIENT_ID --config "$CONFIG"
echo '2/3 : colle le Client Secret Google Web'
$WRANGLER secret put GOOGLE_OAUTH_WEB_CLIENT_SECRET --config "$CONFIG"
echo '3/3 : saisis l’adresse Gmail autorisée (identité exacte du compte Google)'
$WRANGLER secret put GOOGLE_OWNER_IDENTITY --config "$CONFIG"
echo 'Vérification de la présence des paramètres (noms uniquement) :'
$WRANGLER secret list --config "$CONFIG" | grep -E 'GOOGLE_OAUTH_WEB_CLIENT_ID|GOOGLE_OAUTH_WEB_CLIENT_SECRET|GOOGLE_OWNER_IDENTITY'
echo 'FIN. Ne communique aucune valeur dans le chat.'
