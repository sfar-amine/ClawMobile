# Reprise réseau WhatsApp : variante OpenClaw 2026.10.9 — 31 octobre 2026

Préparation de la montée OpenClaw. En 2026.10.9, le contrôleur de connexion WhatsApp arrête toujours le canal après `reconnectPolicy.maxAttempts` sur une perte de transport (DNS, coupure, réseau injoignable), sans aucune relance lente. Le correctif de reprise réseau du S24 reste donc nécessaire.

Le jeu `whatsapp-network-recovery` reçoit sa variante 2026.10.9, dans la table `packages` introduite par #493 :
- `@openclaw/whatsapp@2026.10.9` : `dist/.setup/connection-controller-CejM7bhn.mjs` et `dist/.setup/monitor-DVzumwCI.mjs` ;
- `openclaw@2026.10.9` : `dist/server-runtime-startup-services-CSJSnUKS.mjs`, à l'identique.

L'amont a déplacé `heartbeatSeconds`, `reconnectPolicy` et `keepAlive` sous `this.params`, et fusionné la décision des erreurs d'établissement avec celle de l'authentification instable. Quatre ancres sont donc réécrites ; le comportement reste celui de la 2026.9.6 :
- une perte de transport relance sans fin, d'abord en rafale rapide puis à 60, 120 et 300 s (±20 %), avec un compteur borné ;
- les autres échecs gardent le comportement amont ;
- un 401 arrête comme une déconnexion du compte.

Tests :
- `test-openclaw-compat-variants.py` couvre la variante avec une racine de plugin séparée, et exécute sous node le code patché de la 2026.10.9 ;
- `test-whatsapp-network-recovery.py` : ses racines de fixture portent désormais un `package.json`, comme tout paquet installé.

Limites : il suppose que la 2026.10.9 installe `@openclaw/whatsapp` 2026.10.9 ; c'est vérifié à la répétition de la montée, et toute autre version est refusée avant écriture. La perte réseau réelle sur 2026.10.9 fait partie de la recette de montée.

Retour arrière : revert ; le jeu 2026.9.6 est inchangé à l'octet.
