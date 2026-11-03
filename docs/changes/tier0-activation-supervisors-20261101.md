# Activation tier0 : superviseurs démarrés sans la porte IA, release non éprouvée jamais LKG (01/11/2026)

## Incident
Le 01/11, `companion-deploy.sh 3543780d` (#510 + #513) a été lancé à 22:24 (Tunis). C'est le premier déploiement depuis la bascule OpenClaw 2026.10.9.

Il se termine en `rollback_failed` (`runtime_sync_failed`). Les deux promotions tier0 ont échoué en `activation_readiness_failed` : celle du déploiement à 22:28, puis celle de son retour arrière à 22:35.

Le redémarrage de la Gateway a pourtant réussi (« Targets: 1 (adopted 1) ») : #513 fonctionne.

## Cause exacte (journal du root-guardian sur le S24)
- **Fenêtre de promotion.** `tier0 promote` attend au plus 120 s un échantillon de santé produit par la nouvelle release, avec toutes les capacités critiques saines. `immune.incident_orchestrator` en fait partie.
- **Refus de la porte IA.** À la bascule de release, le root-guardian ne relance pas lui-même un superviseur absent ou décalé : il propose la relance à la porte IA (`immune_action`). La porte a refusé (`ai_gate_refused`), car son modèle répond via la Gateway que le déploiement redémarre.
- **Démarrage trop tard.** Le guardian ne démarre l'orchestrateur en direct (`direct_start reason=ai_gate_unreachable`) que lorsque la porte devient injoignable. Les deux fois, c'était après la fenêtre :
  - retour arrière : échéance 21:37:53 UTC, orchestrateur prêt à 21:38:05 ;
  - déploiement : orchestrateur prêt à 21:30:56, alors que l'échéance tombe au plus tôt à 21:30:51.
- **Les 29/10 et 31/10,** la porte avait accepté en 31 à 33 s.

**Second défaut.** Lors de la promotion du retour arrière, `promote` a lié `last-known-good` à la release qu'il remplaçait. C'était la release 3543780d, qui venait d'échouer son activation. Un soak raté aurait donc renvoyé vers la release cassée.

## Correctif
- **`samantha-root-guardian.sh`.** Pendant l'activation tier0 de sa propre release, le guardian démarre ou remplace directement ses superviseurs, sans passer par la porte IA (journal `action=activation_start reason=tier0_activation`). Les trois conditions sont lues dans `tier0/state.json` :
  - `soak_state == activating` ;
  - échéance `activation_deadline_epoch` non atteinte ;
  - `current` désigne la release du `ROOT` du guardian.

  Le déploiement de l'owner a déjà choisi et vérifié cette release, et la promotion attend précisément ces superviseurs. En dehors de cette fenêtre, rien ne change.
- **`tier0-control.py promote`.** Une release qui n'a jamais passé son soak ne devient plus `last-known-good` : états `activating`, `activation_failed`, `running` et `failed_no_lkg`. Le LKG confirmé reste en place.

## Tests
- `test-root-guardian-gate.py` :
  - démarrage et remplacement pendant l'activation, sans aucun appel à la porte ;
  - fenêtre expirée, autre état, autre release ou état illisible : la porte est consultée ;
  - rejeu de la capture S24.
- `test-tier0-activation-readiness.py` : un LKG confirmé est conservé face aux 4 états non éprouvés, et une release `stable` devient toujours LKG.
- Les nouveaux tests échouent sur le code précédent.

## Fixtures
`openclaw-plugin-mobile-ui/fixtures/s24-2026-11-01-tier0-activation-1009/` : relevé S24 en lecture seule, nettoyé.

## Après fusion
1. Réparer une fois le lien `last-known-good` du S24 : action owner, consignée.
2. Redéployer `3543780d` ou la tête qui suit.

## Retour arrière
Revenir sur ce commit, puis lancer `companion-deploy.sh` vers le commit précédent.
