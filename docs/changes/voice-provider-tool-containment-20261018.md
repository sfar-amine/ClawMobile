# Voix live : un appel d'outil inattendu du modèle ne coupe plus la séance (18/10/2026)

## Problème
Recette d'Amine sur le S24, le 18/10 à 13:09 : « The reply arrived incomplete », avant même qu'il ait parlé.

Trace :
- `voice_start`, puis `warm_socket_open` ;
- 0,9 s plus tard, `voice_fail:voice_error_incomplete_reply:protocol_error:greeting_tool_not_admissible`.

L'historique chargé à l'ouverture contenait la demande « solde Orange » restée sans réponse après la coupure de 12:35. Pendant l'accueil, le modèle a voulu la reprendre en appelant un outil. Le relais traitait ce choix du modèle comme une faute de protocole fatale, et la séance devenait ambiguë.

Les quatre cas d'appel d'outil émis par le fournisseur au mauvais moment étaient tous fatals : accueil, relecture, relecture `public_web` et absence de tour actif. Une sortie du fournisseur sans tour propriétaire l'était aussi.

## Changement
- `voiceTurnProtocol.ts`, nouvelle méthode `refuseProviderTools` :
  - l'appel est répondu au fournisseur comme refusé (`toolResponse`, avec `error: not_admissible` et sa raison) ;
  - il n'est jamais exposé à l'app ni exécuté ;
  - la séance continue ;
  - au-delà de 16 refus dans une séance, l'erreur reste fatale (`provider_tool_refusal_budget`).
- **Sortie du fournisseur sans tour propriétaire** : ignorée et observée (`provider_output_unowned`), jamais attribuée à un autre tour.
- **Consigne d'accueil** : « ne pas agir sur une demande antérieure de l'historique ».
- **Inchangé** : les budgets d'outils (`tool_call_budget`, `pending_tool_budget`) et toutes les fautes de protocole émises par le client restent fatales. Aucun outil n'est jamais exécuté hors d'un tour admis et transcrit.
- **Tests** :
  - `test-voice-turn-protocol.cjs` : accueil et relecture refusés sans erreur, appel sans tour actif refusé, sortie orpheline ignorée, puis tour suivant normal, et borne de 16 refus ;
  - `test-run-web-voice.cjs` : un appel d'outil pendant la relecture `public_web` est refusé sans erreur et n'est jamais exposé.

## Activation
Déploiement Companion (`companion-deploy.sh`), puis recette voix live. Aucun changement d'app nécessaire. Retour arrière : revert.
