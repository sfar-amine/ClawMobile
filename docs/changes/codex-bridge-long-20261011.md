# Bridge long : accusé running puis lecture du reçu

Le relay cloud arrête l'attente à 28 s (`cloud/voice-relay/src/index.mjs`, `device_timeout`), alors que `exec_wait` accepte jusqu'à 300 s. Une expiration du transport ne prouve donc ni échec ni arrêt de la commande.

Le propriétaire `remoteBridge.ts` conserve son exécution et son reçu existants. Pour `exec_wait` seulement, il répond après au plus 12 s avec le reçu `running`, puis écrit normalement le reçu terminal quand la commande finit. Le MCP projette déjà ce reçu avec `retry_allowed:false`; `claw_status` avec les mêmes `action_key`/`step_key` lit le résultat. Les doublons restent dédupliqués. Les autres méthodes conservent leur contrat.

Preuves : la fixture S24 #131 `f6/remote-bridge-stuck-receipts.json` confirme chemins, états et propriétaire. Elle ne constitue pas une mesure d'une commande longue terminée après timeout : cette corrélation reste à capturer par Claude. Le test CI impose une attente réaliste de 12 s, le budget public <15 s, la déduplication avant/après complétion, l'échec et la normalisation d'un reçu orphelin réel en `indeterminate`.

Aucune nouvelle route ni capability : `device.remote_bridge` et les lectures existantes sont conservées. Aucun nouveau store, processus, daemon ou retry. Aucune modification paiement. Compilation et `test-bridge-long.cjs` réussis. La suite historique `test-mcp-bridge.cjs` s’arrête sur SOUL.md canonique absent dans cet environnement (ENOENT), après les premières assertions.

Recette Claude : commande inoffensive >30 s, timeout commande 60 s; conserver le reçu initial `running` en moins de 15 s et le `claw_status` terminal avec mêmes clés. Ne pas relancer sous d'autres clés. Après redémarrage propriétaire, attendre `indeterminate`, jamais succès présumé. Aucun déploiement par Codex.

Retour arrière : revert de ce commit, sans migration ni suppression des reçus.
