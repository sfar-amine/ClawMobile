# Reprises bornées des notifications WhatsApp à Amine — 02/11/2026

## Constat (S24, lecture seule)
`~/.openclaw/health/whatsapp-outbound.log` : 2138 échecs `gateway_call` pour 26 clés seulement (10 finalement acceptées, 16 jamais), 95 clés acceptées en tout. `incident-f73a069c49edd4cf` a été réessayée 979 fois avant son acceptation du 02/11 à 17:19, `incident-7f838a1e81e3d875` 280 fois, `incident-1fc6c7a375679b3a` 109 fois.

## Cause de la tempête
Le propriétaire de la boucle est `incident-manager.sh`. Après 3 échecs WhatsApp, il tentait l'e-mail ; si l'e-mail échouait, il reprogrammait `next=now+300` sans plafond. Chaque passage suivant relançait WhatsApp **et** l'e-mail : 12 essais par heure, sans fin (`channel=email state=failed retry_in_s=300` 934 fois pour `f73a…`). `whatsapp-owner-send.sh` n'avait ni budget ni mémoire par clé.

Deuxième défaut : la même clé était renvoyée après acceptation. L'`idempotencyKey` du Gateway ne déduplique que sur une fenêtre courte : `incident-25c564165b64d057` a été acceptée 152 fois avec 103 identifiants de message distincts, car chaque cycle RDC rouvert par `incident-notify.sh` réutilisait la clé `incident-<id>`, et la clé de récupération de `incident-close.sh` aussi.

## Cause des échecs `gateway_call` (rc=1)
Le Gateway répond mais le canal WhatsApp n'a pas d'écouteur actif : `send` échoue en ~1 s avec `errorCode=UNAVAILABLE` « No active WhatsApp Web listener (account: default) ». La CLI sort en rc=1 ; `elapsed_s` (1 à 5 s, parfois 14 s) est surtout le démarrage de la CLI. Preuves :
- 02/11 17:22:32 (`recovery-bc62…`, 14 s) : rechargement des plugins après le déploiement de 17:14 (« Plugin whatsapp forced retirement »), connexion WhatsApp Web fermée (408), puis `res ✗ send … UNAVAILABLE` ;
- 30/10 : le gestionnaire de santé voyait `service=whatsapp state=degraded failures=6` de 08:07 à 09:05 pendant que chaque passage échouait en rc=1 ; sur l'historique, `reason=channel_not_connected` revient 219 fois.

La correction de la connexion WhatsApp elle-même (reconnexions 408/428/503, rechargement de plugin) est hors de ce lot.

## Changement
- `owner_notify_retry.py` (nouveau, appelé par `whatsapp-owner-send.sh`) : politique par clé, lue dans le journal existant, sans nouveau store ni démon. Clé acceptée : jamais renvoyée (code 0, identifiant précédent). Après n échecs : attente de min(60·2^(n−1), 1800) s (code 75, rien n'est envoyé). À 12 échecs ou 24 h après le premier : une seule ligne `state=undeliverable`, puis code 76 sans envoi.
- `incident-manager.sh` : suit `next_attempt_at` donné par le propriétaire de l'envoi ; un report (75) ne compte pas comme essai ; l'e-mail n'est tenté qu'après un vrai essai WhatsApp, et une dernière fois à l'état terminal ; statut `undeliverable` enregistré une fois. Plafond propre de 12 essais si la politique manquait. Mode `CLAW_INCIDENT_MANAGER_ONCE=1` pour les tests.
- `incident-notify.sh` : un cycle RDC/contexte rouvert reçoit `cycle=n` et donc la clé `incident-<id>-c<n>` ; une alerte identique à un incident `undeliverable` n'est pas remise en file.
- `incident-close.sh` : clé de récupération par cycle (identique à avant pour le cycle 0).
- Visibilité sans nouveau canal : `health-verdict.py` publie la ligne non critique `notification.owner_delivery`, dégradée pendant 24 h après un `undeliverable` (`notification_undeliverable,count=N`, clés). Elle apparaît dans la vue santé de l'app et une fois dans « Points à surveiller » du rapport quotidien (`health/current.json`). Le gestionnaire de santé ne la lit pas. La dernière preuve d'envoi de `notification.whatsapp` ignore la ligne `undeliverable`. App : libellé et description de cette ligne.

## Tests
`installer/termux-lite/test-owner-notify-retry.py` (inscrit dans `.github/workflows/ci.yml`) : calendrier, plafonds, état terminal unique, aucun renvoi après acceptation ni après `undeliverable`, rejeu des pannes réelles de `f73a…` et `1fc6…` (12 essais au lieu de 979 et 109), scripts réels avec Gateway simulé, gestionnaire et cycles RDC. Fixtures : `openclaw-plugin-mobile-ui/fixtures/s24-2026-11-02-owner-notify-retry/`.

## Retour arrière
Revenir sur ce commit et redéployer le core avec `installer/termux-lite/companion-deploy.sh <commit>`. Les traces laissées sont sans danger pour l'ancien code :
- une ligne `state=undeliverable` du journal peut devenir la « dernière preuve d'envoi » de l'ancien `health-verdict.py`, mais ce n'est pas un échec, donc elle ne dégrade rien ;
- les fichiers `cycle` et `undeliverable` des dossiers d'incident sont ignorés ;
- un incident au statut `undeliverable` n'est plus jamais envoyé par l'ancien gestionnaire. Pour le relancer, remettre `pending` dans son fichier `status`.
