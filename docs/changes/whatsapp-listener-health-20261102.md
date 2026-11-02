# WhatsApp sans écouteur actif : mesure juste, reprise sûre, courte attente à l'envoi — 02/11/2026

Base : `claude/notify-retry-cap` (PR #523), qui touche les mêmes fichiers (`whatsapp-owner-send.sh`, `health-verdict.py`).

## Constat (S24, lecture seule)
Les envois propriétaire échouent avec `UNAVAILABLE` « No active WhatsApp Web listener (account: default) » et rc=1 quand l'envoi tombe pendant un trou d'écouteur.

**Ce que fait OpenClaw 2026.10.9.**
- Une fermeture WhatsApp Web (408, 428, 503, ou 499 du chien de garde) retire l'écouteur. OpenClaw se reconnecte seul, d'abord en 2 s puis avec un facteur 1,8, jusqu'à 30 s au plus, en 12 essais rapides.
- Avec le correctif Samantha `whatsapp-network-recovery` (vérifié sur le S24), OpenClaw continue ensuite toutes les 1, 2 puis 5 min. Il n'abandonne jamais sur une erreur de transport.
- Au-dessus, le gestionnaire de canaux relance le compte 10 fois au plus (de 5 s à 5 min), puis écrit `giving up`. Cela n'est jamais arrivé dans les journaux couverts.
- Un rechargement de configuration retire de force les plugins après 5 s, ce qui ferme la connexion. Un redémarrage du Gateway laisse 18 à 27 s entre « http server listening » et « Listening », plus le temps d'arrêt et de démarrage.
- Sans écouteur, `send` refuse aussitôt (`PlatformMessageNotDispatchedError`) : rien n'est expédié.

**Trous mesurés dans le journal Gateway (31/10–02/11, environ 34 h couvertes).**
- 31 trous : 10 fermetures 408, 8 reprises 499, 6 fermetures 428, 4 démarrages du Gateway, 2 fermetures 503 et 1 rechargement de plugin.
- Durée médiane 5,9 s, p90 18 s, maximum 76 s.
- Un seul envoi est tombé dans un trou : le 02/11 à 17:22:31, pendant les 5,9 s d'un rechargement à chaud. Ce rechargement venait d'une édition manuelle de `agents.entries.main.tools` (`openclaw.json.bak-mec-20261102`, 17:22:08). Il ne venait pas du déploiement de 17:14.

**Vraies coupures longues.** Il y en a eu trois, la nuit, Wi-Fi coupé sans bail (`network_safety wifi_disabled_without_lease`) et SMTP en panne aussi :
- du 26/10 à 23:34 au 27/10 à 07:46 ;
- du 28/10 à 23:08 au 29/10 à 08:47 ;
- du 29/10 à 23:39 au 30/10 à 09:09.

C'est le cas du 30/10 entre 08:07 et 09:05. WhatsApp est revenu seul, 4 min après le Wi-Fi. Ces trois nuits portent 621 des 625 envois échoués de la semaine.

**Gestionnaire de santé : fausses coupures.**
- La sonde `timeout 8 openclaw channels status` coupe la CLI, qui met 9,3 à 11,3 s sous une charge de 6. Une sortie vide était lue comme `channel_not_connected`.
- Sur la semaine : 231 épisodes `channel_not_connected`. Parmi les 127 situés dans les heures couvertes par le journal Gateway, 4 seulement correspondent à une vraie fermeture.
- 24 incidents ont été ouverts avec `no_repair_handler`.
- De plus, le refus de 17:22:32 a gardé WhatsApp en `latest_outbound_failed` plus de 3 h alors que le canal était connecté. Des incidents ont été ouverts à 17:28, 18:16, 18:56 et 19:56.

**Aucune reprise sûre câblée.** Un compte arrêté (`stopped`) n'avait aucun gestionnaire de réparation. Seul un verrou périmé déclenchait un redémarrage complet du Gateway.

## Changement
- `health-verdict.py` :
  - la sonde d'état a maintenant un budget de 15 s ;
  - une sortie vide donne `unverified/channel_status_unreadable`, et non plus une coupure ;
  - un compte activé mais `stopped` donne le nouveau motif `channel_stopped`. `running` sans `connected` reste `channel_not_connected` : la reprise appartient à OpenClaw ;
  - un refus `reason=listener_unavailable` cesse de dégrader quand le canal est vu connecté 90 s après. Ce délai est sous la grâce de 120 s, donc un refus seul n'ouvre jamais d'incident.
- `samantha-health-manager.sh` :
  - une lecture illisible n'ouvre, ne remet à zéro et n'escalade aucune coupure ;
  - `channel_stopped` au-delà de la grâce appelle `channels.start` pour whatsapp/default. C'est la méthode Gateway d'OpenClaw, celle qu'appelle `channels login`. Un compte déjà possédé par une tâche répond `retry/task-owned` et n'est pas touché. Il n'y a ni redémarrage du Gateway, ni changement de session ;
  - l'appel passe par la porte immunitaire (`bounded-channel-start`), avec la même règle de repli direct que la réparation du Companion. Il est sauté en mode déploiement et cadencé par `fail`, qui ouvre toujours l'incident au 3ᵉ échec.
- `whatsapp-owner-send.sh` :
  - après un refus rapide `UNAVAILABLE` « No active WhatsApp Web listener », lu dans l'enveloppe JSON de la CLI, la même requête idempotente est rejouée après 3 s, tant qu'il reste 8 s dans le budget de 17 s. Les appelants gardent leur `timeout 18`. Aucune autre erreur n'est rejouée ;
  - le script écrit toujours une seule ligne de journal par appel, avec `holds=N` et `reason=listener_unavailable`. La politique par clé de #523 est inchangée.
- Rien ne bloque le démarrage d'un service. Le déploiement n'attend pas WhatsApp, car aucun échec d'envoi n'est imputable à un redémarrage de déploiement dans les journaux couverts.

## Tests
`installer/termux-lite/test-whatsapp-listener.py` (20 tests, inscrit dans `.github/workflows/ci.yml`) :
- intégrité et nettoyage des fixtures ;
- statistiques réelles des trous ;
- refus de 17:22:31 tombé dans le rechargement de plugin ;
- incidents du 02/11 sans trou au-delà de la grâce ;
- budget de la sonde et lignes d'état réelles ;
- verrou `latest_outbound_failed` sur la ligne réelle de 17:22:32 ;
- rejeu du 02/11 16:11–20:01 dans la vraie fonction `check_whatsapp` : l'ancienne lecture escalade, la nouvelle n'ouvre aucun incident ;
- `channels.start` : un seul appel, jamais pour un canal en reprise, sauté en déploiement, attente si la porte refuse ;
- attente à l'envoi : réussite après 2 refus, borne de budget, pas de reprise après un refus lent ni après une autre erreur.

Une mutation de chacun des trois correctifs fait échouer 6 tests. `test-whatsapp-channel-health.py` est mis à jour : `stopped` donne `channel_stopped`.

Fixtures : `openclaw-plugin-mobile-ui/fixtures/s24-2026-11-02-whatsapp-listener/`.

## Retour arrière
Revenir sur ce commit, puis redéployer le core avec `installer/termux-lite/companion-deploy.sh <commit>`. Les traces laissées sont sans effet sur l'ancien code :
- les lignes de journal `reason=listener_unavailable holds=N` ne sont lues que par `state=` et `key=` ;
- un `unverified` ou un `channel_stopped` déjà publié dans `health/current.json` est remplacé au relevé suivant ;
- l'ancien code retombe dans son chemin `fail`.
