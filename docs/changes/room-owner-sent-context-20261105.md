# La pièce d'un contact voit les messages envoyés au nom d'Amine (05/11/2026)

## Pourquoi
Depuis le chat d'Amine, Claude peut envoyer un message WhatsApp à un contact autorisé (`send_owner.py` → `people-trusted.py whatsapp_send` → Gateway `send`). Le modèle de la pièce du contact (session `agent:<agent>:whatsapp:direct:+<e164>`) ne voit jamais ce message.

OpenClaw le reflète dans la session de `main`. Même dans la bonne session, les messages `delivery-mirror` sont retirés du rejeu du modèle. Quand le contact répond « ok », la pièce ne sait pas à quoi il répond.

Les avis de `roomSendApprovals` (« Amine a confirmé / refusé / n'a pas confirmé à temps ») ont le même trou.

## Ce qui change
- Une méthode Gateway du plugin est ajoutée, `samantha.room.owner_sent` (portée `operator.write`). Son entrée fermée est `{e164, messageId, at, text}`, avec deux champs optionnels :
  - `source` : `owner_via_samantha` par défaut, ou `room_send_outcome` ;
  - `sessionKey`.

  Les contrôles : E.164, id opaque, heure ISO UTC, texte de 4000 caractères au plus, sans caractère de contrôle.
- La méthode lit le grant par la lecture existante de people-trusted (`allowlistRead get`). Elle route le contact comme `room_agent` (`roomAgentFor`). Elle met en file une injection du tour suivant par `api.session.workflow.enqueueNextTurnInjection`, avec :
  - le texte `[Message envoyé par Amine via Samantha · <at> · id <messageId>] « <texte> »` ;
  - la clé `owner-send:<messageId>` ;
  - `prepend_context`, une TTL de 7 jours, et les métadonnées `{messageId, at, source}`.
- Réponses fermées :
  - `no_room` : pas de grant actif d'une pièce ;
  - `no_session` : la pièce n'a pas encore de session, et aucune n'est créée ;
  - `prompt_injection_disabled` ;
  - `already_enqueued_or_full` ;
  - `room_changed` ;
  - `allowlist_unavailable` ;
  - `injection_unavailable`.
- `people-trusted.py whatsapp_send` appelle cette méthode juste après le reçu `accepted`, dans un `try/except`. Il ne le fait ni sur le chemin de livraison QA, ni pour un document. Un échec ne change, ne fait échouer ni ne rejoue l'envoi, et le rejeu d'un reçu accepté s'arrête avant cet appel. Le message d'accueil R17 passe `room_context=False`.
- `roomSendApprovals` `tell()` met chaque avis envoyé dans la session de pièce de l'entrée (`entry.room.sessionKey`), avec sa clé d'envoi et la source `room_send_outcome`. Le libellé est alors « Message envoyé au contact par Samantha ».
- `sessionKey` et `agentId` ne sont pas ajoutés au `send`. Le reflet de `main` (historique d'Amine) reste où il est, et le modèle ne rejoue pas ces messages.

## Limites
- **Tour suivant seulement.** L'injection est vidée au prochain tour de la pièce, puis supprimée. Sans réponse du contact, elle expire au bout de 7 jours.
- **Session de pièce existante requise.** Sans elle, la méthode répond `no_session`. `createSessionEntry` existe dans le runtime 2026.10.9, mais une session créée par le plugin n'aurait pas l'origine WhatsApp du routage.
- **Configuration.** L'injection exige que `plugins.entries.openclaw-plugin-mobile-ui.hooks.allowPromptInjection` soit absent ou à `true`. C'est le cas sur le S24 le 05/11 : le champ est absent. À `false`, la méthode répond `prompt_injection_disabled`.
- **Budget.** people-trusted attend au plus 4 s, plus les 5 s de marge du CLI, après l'envoi. Le budget de l'appelant `send_owner.py` n'a pas été mesuré.
- **Recette.** Aucune recette réelle sur le S24 pour l'instant.

## Retour arrière
Revert du commit, puis `companion-deploy.sh` du commit précédent.

L'appel de contexte est détaché du processus d'envoi : un appel bloquant (démarrage du CLI + 4 s) pouvait pousser un envoi déjà accepté hors du budget de son exécuteur, et le faire passer pour incertain.
