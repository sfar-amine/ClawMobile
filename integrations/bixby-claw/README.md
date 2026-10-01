# Bixby → Claw private capsule

Cette capsule reste volontairement mince : Bixby gère le dialogue de surface et
Claw reste la source de vérité pour les capacités, le raisonnement et les
learnings.

## Architecture

- Named dispatch Bixby sélectionne `samantha.clawvoice`.
- Le reste de l'utterance est capturé comme `Request` et envoyé à `AskClaw`.
- Si Claw répond `needs_clarification`, la capsule déclenche un Input Moment.
- Bixby pose la question retournée par Claw, capture une
  `ClarificationAnswer`, puis `ContinueClaw` rappelle le relay avec le même
  `conversationId`.
- Le relay ferme chaque HTTP après le tour. Aucune connexion HTTP n'attend
  l'utilisateur.
- Le S24 conserve seulement un état court de conversation (TTL 10 minutes).
- Un nouveau learning ou une nouvelle capacité Claw ne nécessite pas de logique
  métier supplémentaire dans la capsule.

## Configuration

1. Capsule ID : `samantha.clawvoice`.
2. Target : `bixby-mobile-fr-FR`.
3. Runtime : 9, JavaScript Runtime v2.
4. Developer Center > Configuration & Secrets :
   - configuration `relay.url` = URL HTTPS stable du Worker Cloudflare ;
   - secret `relay.token` = OWNER_TOKEN du Worker.
5. Ne jamais stocker de token dans Git ou `capsule.properties`.

## Training

Ne pas inclure le dispatch name dans les exemples de training : Samsung retire
le pattern de named dispatch avant l'interprétation de la capsule.

Créer plusieurs exemples variés et annoter **toute la phrase** en Value Node
`Request`, avec Goal `AskClaw` (ou `Response` si le plan généré conserve
explicitement `AskClaw` comme goal signal).

Exemples recommandés :

- `mon solde Orange`
- `ce que j'ai demain`
- `cherche le numéro de Sami`
- `explique-moi le dernier incident`
- `envoie un message à Amine Sadfi`
- `rappelle-moi de faire les courses demain`

L'objectif n'est pas d'énumérer les capacités de Claw, mais d'apprendre à Bixby
que le texte restant après named dispatch est une demande libre.

Les réponses aux clarifications n'ont pas besoin d'être ajoutées comme
capacités : Bixby les collecte dans l'Input Moment `ClarificationAnswer`.

## Contrat relay

### Premier tour

```json
{
  "requestId": "bixby-...",
  "request": "mon solde Orange"
}
```

Réponse finale :

```json
{
  "success": true,
  "state": "done",
  "text": "..."
}
```

Clarification :

```json
{
  "success": true,
  "state": "needs_clarification",
  "conversationId": "conv-...",
  "question": "Précise : solde de recharge ou tous les soldes."
}
```

### Tour suivant

```json
{
  "requestId": "bixby-...",
  "conversationId": "conv-...",
  "answer": "tous les soldes"
}
```

Le même mécanisme peut reboucler plusieurs fois jusqu'à `state=done`.

## Recette

1. Save All puis Recompile : 0 erreur.
2. Compile NL Model : exemples `Learned`.
3. QR/On-device testing owner-linked.
4. Test initial via named dispatch :
   `demande à Claw mon solde Orange`.
5. Bixby doit poser la clarification retournée par Claw.
6. Répondre simplement `tous les soldes`, sans répéter le dispatch.
7. Vérifier un seul effet par `requestId`, relay connecté/authentifié et réponse
   finale dans Bixby.

Le mode On-device testing redirige largement les utterances vers la révision de
test. Ne pas utiliser le comportement d'une utterance bare sous ODT pour
conclure sur le routage production natif de Bixby.
