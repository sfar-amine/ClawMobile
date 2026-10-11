# P1 — Identité de l'appelant liée au tour

La capability compacte utilise une factory OpenClaw, et non un outil statique
qui interprète `caller` fourni par le modèle comme une preuve d'identité.
OpenClaw 2026.9.6 fournit `senderIsOwner` dans le contexte trusted de sa factory.
Le premier argument d'`execute` est l'identifiant de l'appel d'outil, pas ce contexte.

`senderIsOwner === true` donne `owner`. Toute autre valeur donne `other` ; aucun
nom d'agent, de session, de surface ou argument du modèle ne donne ce privilège.
Un argument `caller` qui contredit cette identité est refusé avec
`status:error, reason:caller_not_admitted`, avant tout lancement du propriétaire.
L'exécution sans bit d'identité du host est également refusée. Une résolution
sans preuve reste une résolution `other`. La lecture non-owner conserve les
autorisations du Capability Graph ; ce correctif ne crée pas d'autorisation.
La preuve live `assertInvocationCurrent`, quand OpenClaw la fournit, est
revérifiée juste avant chaque lancement du helper. Son refus ne lance rien.

Le même outil et la même factory appliquent cette règle à l'app, à la voix,
à WhatsApp et aux appels MCP passés par l'agent. Le pont MCP direct conserve
son admission authentifiée existante ; aucun profil fourni par le modèle
n'est accepté ici. Aucune nouvelle route HTTP, aucun nouveau registre et aucun
changement du paiement déterministe, des confirmations ou du Capability Graph.
Le budget du helper reste inchangé (timeout borné à 2–120 s). L'admission est
synchrone, sans IO ni appel Gateway ; aucune ligne de recette HTTP n'est ajoutée.

## Preuves et limite de qualification

La capture S24 `fixtures/s24-2026-10-10/r17/inbound-schema.json` fournit le bit
réel dans `message.__openclaw.senderIsOwner`. Les formes non-owner/falsifiées
sont des contrôles négatifs dérivés de cette forme, pas des captures inventées.
Le contrat factory est extrait du paquet public exact `openclaw@2026.9.6`
dans `fixtures/protocol/openclaw-2026.9.6/`, provenance et hash du source inclus.
Ce paquet est de la même version vérifiée par Claude sur le S24 ; l'extrait
public n'est pas présenté comme une capture S24.

La qualification de bout en bout reste à Claude : capturer le contexte factory
nettoyé sur un tour owner et un tour non-owner pour les quatre surfaces,
confirmer la propagation de `senderIsOwner` et la présence éventuelle de
`assertInvocationCurrent`. Aucun identifiant de contact ni contenu du tour
n'est nécessaire. Sans preuve owner, l'exécution échoue fermée.

Les tests utilisent un helper local compteur : un owner appelle le propriétaire,
un owner falsifié/non-admis n'appelle aucun helper. Ils passent par la vraie
registration du plugin et sont inscrits dans `ci.yml` avec les tests existants.
Retour arrière : revert de cette PR ; aucune migration ni activation par Codex.
