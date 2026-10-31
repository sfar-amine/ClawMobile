# Parcours de déploiement : un accès fournisseur expiré est inconclusif — 31 octobre 2026

## Constat (S24, 31/10 à 12:02)

- `owner_read` envoie « Qu'est-ce que j'ai dans mon agenda demain ? ». Le cerveau appelle `samantha_agenda` (`agenda.event.read`).
- Résultat de l'outil : `FAILED`, `facts.reason` `google_authorization_unavailable`, `answer` « La demande n’a pas abouti. Consulte le détail avant toute nouvelle action. ». Le cerveau la répète.
- Cause réelle : Google refusait le rafraîchissement du jeton (`invalid_grant`, jeton expiré ou révoqué).
- Le parcours a classé `broken_reply` et refusé l'activation d'une PR playbooks sans rapport (Orange) : `PARCOURS_FAILED`. Amine a dû se reconnecter avant toute activation.

## Correctif

- Une autorisation fournisseur à refaire est **inconclusive**, raison `provider_authorization_expired`, comme une panne fournisseur : jamais de retour arrière ni de refus d'activation (sortie 3).
- Signal principal : le **reçu** de l'outil typé du tour jugé, lu en lecture seule dans le transcript de l'agent (le magasin déjà lu par `claw-live.py`), pour la session de recette et **ce tour seulement** : un résultat `samantha_*` en échec dont `facts.reason` est un code d'autorisation Google des playbooks (`google_authorization_required`, `_unavailable`, `_revoked`, `_storage_permissions`, `google_tasks_authorization_required`).
- Signal de repli : la phrase nommée des playbooks (« L’accès à ton agenda Google a expiré : il faut le reconnecter. » et reformulations proches). Elle ne compte seule que si les résultats d'outil du tour sont inconnus. Lus et sans cette cause, la réponse échoue (`unconfirmed_provider_authorization`).
- Sans aucun des deux signaux, la phrase générique reste `broken_reply`. Tout autre chemin cassé fait toujours échouer le passage.

## Traitement par les scripts

- `activate-ui-playbooks.sh` : sortie 3 → l'instantané est gardé (`ACTIVATED`), sortie 1 → retour à l'instantané précédent (`PARCOURS_FAILED`, sortie 5). Inchangé.
- `companion-deploy.sh` : sortie 1 → retour arrière `parcours_failed` ; sortie 3 → déploiement gardé, la section `parcours` du reçu porte la raison. Inchangé.
- `deploy-after-maint.sh` n'est dans aucun des deux dépôts : non inspecté.

## Tests

`installer/termux-lite/test-deploy-parcours.py` (déjà dans `ci.yml`), fixture `openclaw-plugin-mobile-ui/fixtures/s24-2026-10-31-agenda-auth-revoked/parcours-owner-read.json`. Sur la base, les nouveaux tests échouent, et la base aurait jugé la nouvelle phrase `passed`.

## Limites

- La forme exacte d'une ligne du transcript de la session de recette n'a pas été capturée sur le S24 (pas d'accès au téléphone dans ce lot) ; elle suit le lecteur déployé `claw-live.py`. Si elle diffère, la cause est « inconnue » et la phrase décide.
- Un passage inconclusif garde l'activation : le chemin agenda n'est alors pas vérifié pour ce déploiement, et le reçu le dit.

Retour arrière : revert de ce commit.
