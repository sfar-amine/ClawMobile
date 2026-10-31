# Cerveau : heure de Tunis dans chaque tour propriétaire — 31 octobre 2026

Banc voix du 31/10 sur le S24 (core 446945af, `SAMANTHA_BRAIN_ONLY=1`). De la fin de parole (t25) au premier audio (t30) :
- « quelle heure est-il » : 12,0 s, car le cerveau a appelé un outil pour l'heure ;
- « merci Samantha » : 6,2 s, sans outil.

Chaque étape du modèle coûte environ 2,5 à 3,8 s.

## Cause

Le prompt système d'OpenClaw 2026.9.6 contient `buildTemporalContextSection` : la date seule, le fuseau, puis « For the exact current time, use `session_status` ». `session_status` est un outil du cœur, derrière Tool Search. Le cerveau cherche l'outil, puis l'appelle : deux étapes de modèle en plus.

L'horodatage que le SDK ajoute aux messages utilisateur dépend du fuseau de l'hôte (`resolveUserTimezone`, repli sur `Intl`), qui n'est pas garanti à Tunis sur Termux.

## Changement

- **Repère d'heure.** Chaque tour propriétaire envoyé par `submitToOpenClawAgent` commence par l'heure locale de Tunis, dans le format d'enveloppe du SDK : `[Sat 2026-10-31 09:21 GMT+1] [companion-session:…]`.
  - Le SDK garde une enveloppe déjà présente et n'ajoute pas la sienne.
  - Le texte est persisté avec le message : la chaîne de cache du prompt est inchangée.
  - `stripConversationTransport` l'enlève déjà à l'affichage.
- **Consigne statique.** Le contexte propriétaire reçoit `## HORLOGE` (`OWNER_CLOCK_NOTICE`), dans le préfixe stable mis en cache. Elle dit de répondre à l'heure, la date, le jour ou une date relative depuis ce repère, sans aucun outil (ni `session_status`, ni `tool_search`, ni commande).
- **Hors périmètre.** Les tours non propriétaires et les commandes `/…` sont inchangés.

Aucun pré-routeur : c'est le cerveau qui répond, avec un fait de contexte en plus.

## Gain attendu

Pour « quelle heure est-il » et « on est quel jour » : zéro appel d'outil au lieu de `tool_search` puis `session_status`. Le gain estimé est d'environ 5 à 6 s, soit deux étapes de modèle. Le tour revient au coût d'un tour sans outil, environ 6 s aujourd'hui.

## Test

`scripts/test-owner-turn-clock.cjs` exécute les fonctions exactes du SDK public (`fixtures/s24-2026-10-31-owner-clock`) et la frontière modèle du module `builtin`, identique au S24. Il vérifie :
- la section « Temporal Context » renvoie à `session_status` ;
- le repère du Companion est identique à `formatZonedTimestamp` pour Africa/Tunis, y compris à minuit et au changement d'année ;
- la frontière garde ce repère, alors qu'un hôte en UTC aurait horodaté une heure trop tôt ;
- le chemin réel de soumission : enveloppe, consigne, affichage ;
- le contexte système reste stable quand l'heure change ;
- les tours non propriétaires et les commandes `/…` sont inchangés.

Le test passe aussi avec `TZ=Asia/Bahrain`.

## Retour arrière

Revert du commit. Le cerveau revient au repère de l'hôte et à `session_status`.
