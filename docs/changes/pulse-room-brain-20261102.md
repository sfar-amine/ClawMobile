# Pièce Pulse : le cerveau du contact autorisé remplace l'interprétation native — 2026-11-02

Décision d'Amine du 02/11 : « Un autorisé sur une pièce peut tout faire dedans. » Sadok (pièce Pulse) a la même
expérience qu'Amine : son cerveau raisonne avec les outils typés de sa pièce. Un seul chemin, sans bascule ni repli
natif. ADR : [ADR-20261102-pulse-room-brain](../08-decisions/ADR-20261102-pulse-room-brain.md).

## Conception

### Flux d'un message
1. **Routage (inchangé).** Un message WhatsApp du contact arrive sur `contacts-pulse` ou `contacts-projet-pulse`
   par son binding R17 (écrit après la biométrie d'Amine).
2. **Plus d'interception.** `before_dispatch` ne traite plus la pièce Pulse. Restent seulement le propriétaire et les
   pièces agenda, actions, messages et qa. Le tour va au cerveau de l'agent du contact.
3. **Contexte du tour.** Le prompt contient seulement le SOUL/AGENTS/USER de l'espace de la pièce.
   `ownerFoundationHook` sort dès que `agentId !== 'main'` : pas de bootstrap, de fondation, de mémoire d'Amine ni de
   préchargement de skill #126. Un test le vérifie, y compris sur un mot qui déclencherait un skill propriétaire.
4. **Outils.** La fabrique typée unique donne à une session de pièce Pulse un seul outil, `samantha_pulse`. Ses
   actions sont celles du domaine `pulse` en `command`/`ready` : ni propriétaire navigateur, ni candidate, ni
   `confirm`/`cancel`. L'outil porte `canDeliverSourceReply` et `catalogMode: "direct-only"`. La politique d'outils
   de l'agent (`pulse-room.py`) ferme tout le reste.
5. **Appel.** `before_tool_call` enregistre une preuve d'invocation au principal `room:pulse:wa-…`. Le registre est
   partagé par les copies du plugin.
   - `execute` consomme cette preuve (`consumeRoomInvocation`). Une preuve propriétaire n'est jamais acceptée ici, et
     la preuve du contact ne l'est jamais par les outils propriétaires.
   - `leave.request` est refusé tout de suite.
   - Le grant de pièce est lu **une fois par message entrant** : la clé est le `runId` du tour, avec un cache
     process-wide borné.
   - L'hôte émet un paquet `native-pulse.v1` de 30 s et l'envoie sur le stdin privé de `claw-capability.py typed-tool`.
6. **Playbooks.** `room_tool_turn` admet le paquet (`admit_private_native_event`), puis l'invocation
   (`admit_room_invocation` : principal du contact, domaine `pulse` seulement). Le coordinateur reçoit la portée
   `pulse_room` et l'événement de pièce, comme la pièce native.
   - Une lecture s'exécute.
   - Une écriture est préparée (dry run) puis **toujours arrêtée à son hand-off**. Le report est imposé côté
     playbooks, quel que soit l'hôte.
7. **Écriture.** L'hôte relit le grant **sans cache**.
   - S'il est valide : `handoff` du même événement. On retrouve les garanties des écritures typées du propriétaire :
     grant de la commande préparée, exécution de la commande préparée, relecture fraîche et vérification par le
     propriétaire Pulse, aucun rejeu après un résultat incertain.
   - S'il ne l'est pas, ou si le tour a été arrêté : `abort`, et rien n'est envoyé à Pulse.
8. **Réponse.** Le texte déjà rédigé par un propriétaire est remis tel quel (`details.sourceReply`), et le tour se
   termine. Cela couvre : question pour une valeur manquante, refus, échec, heures de fermeture, phrase propriétaire
   d'une lecture ou d'une écriture vérifiée. Quand une lecture ne rend que des faits vérifiés (phrase de reçu
   générique), ces faits vont au modèle avec la consigne de n'utiliser qu'eux.

### Pourquoi la remise directe, et pas seulement une consigne
La remise directe (`canDeliverSourceReply`, documentée sur le S24 dans `plugins/tool-plugins.md` § « Deliver the
reply directly ») retire le modèle de la réponse, là où il pourrait inventer. Une consigne seule laisserait le modèle
reformuler un résultat, un chiffre ou une question.

Les lectures Pulse n'ont pas toutes une phrase propriétaire. Pour celles-là, le modèle reçoit les seuls faits du
reçu, comme dans les tours typés d'Amine. Sinon le contact recevrait « Le résultat de la demande reste à vérifier ».

### Où la portée est imposée
| Couche | Contrôle |
| --- | --- |
| Politique d'agent (`pulse-room.py`) | `contacts-pulse` : `samantha_pulse`, `transmettre_a_amine`, `noter_contact`, rien d'autre (plus de `web_search`). `contacts-projet-pulse` : garde `read` (espace projet, `workspaceOnly`) et `web_search` de la pièce Projet. exec, write, edit, message, mémoire, sessions, gateway, cron, nodes et `clawmobile_capability` refusés. |
| Fabrique (`index.ts`, `pulseRoomBrain.ts`) | Outil donné seulement si l'agent est un des deux agents de pièce, si la clé de session est sa session WhatsApp directe et si l'acteur n'est pas le propriétaire. Les outils propriétaires restent réservés à `main`. |
| `before_tool_call` (`capabilityAgentGuard.ts`) | Dans une session de pièce, seul `samantha_pulse` est admis, jamais avec `senderIsOwner`. La preuve porte le principal du contact. |
| Grant (`roomGrantPacket`) | Lecture people-trusted (`allowlistRead get`) : actif, non propriétaire, pièce Pulse, pas `maison`, agent routé égal à l'agent courant, numéro et identifiant cohérents, non expiré. Lue une fois par message, plus une fois juste avant l'écriture. |
| Playbooks (`room_tool_turn`, `admit_typed_tool`) | Hôte fermé (sans clé `owner`), paquet lié à la conversation et à l'événement, domaine `pulse` seulement, principal lié au hash de contrat. Une décision préparée pour le contact ne s'exécute jamais sous l'admission propriétaire. |
| Coordinateur (`transition.scope_verdict`) | Portée `pulse_room` inchangée : écriture directe seulement si elle est complète, question pour une valeur manquante, `leave.request` refusé, tout le reste refusé. |

### Ce qui est retiré
- Dans ce lot :
  - `src/pulseRoomFastPath.ts` : interception `before_dispatch`, `pulseRoomMayUseModel`, rendu natif ;
  - leurs tests `test-pulse-room-fast-path.cjs`, `test-native-pulse-paired.cjs` (C16) et `test-native-fast-paired.cjs` (C18) ;
  - leurs étapes CI ;
  - l'ancien runner de recette.
- Hors de ce lot, du code natif devient mort. Il est retiré par une PR suivante, pour garder ce lot relisible et ne pas
  mêler deux dépôts :
  - core `src/modelFastPath.ts` : options `nativePulse`/`nativePulseMode`, `runNativePulseHandoff`, paquet natif,
    `SAMANTHA_NATIVE_PULSE_FD` ;
  - core `src/companion/remoteBridge.ts` : `submitNativePulseRequest`, branches `nativePulseProtocol`, `NativeAccess` ;
  - core `src/nativePulseAdmission.ts` : `NativePulseContact`, `admitNativePulseContact`, `AUTHORITY_FRESH_MS`.
    `NATIVE_PULSE_PROTOCOL` reste ;
  - core `src/dialogueSurface.ts` : champ `nativePulse` ;
  - core `src/intentInterpreterPort.ts` : `NATIVE_PULSE_PURPOSE`, `nativePulseRequest` ;
  - core `installer/termux-lite/model-fast-path.py` : `--native-pulse-mode`, `run_native_pulse`,
    `_read_native_pulse_input`, contexte et lecture rapide natifs ;
  - core `people-trusted.py` : `_native_pulse_context_read`, et `read_native_instructions` dans `project-room.py` et
    `pulse-room.py` ;
  - core, tests : `test-native-pulse-handoff.cjs`, `test-native-pulse-private-input.py`, la partie native de
    `test-native-room-owner-readers.py` ;
  - S24 : la variable `SAMANTHA_NATIVE_PULSE_HANDOFF` ;
  - playbooks `dialogue/native_handoff.py` : `NativePulseHandoff` et les rendus de bridge. `NativePulseEvent`,
    `admit_private_native_event`, `ROOM_INTENTS` et `native_phase_question_allowed` restent, réutilisés ;
  - playbooks : `dialogue/native_fast.py`, `dialogue/native_context.py`, `interpretation_native_context.py`, les
    branches `pulse_room` de `intent_dialogue.py` et du catalogue d'interprétation ;
  - playbooks, tests : `test_native_pulse_handoff`, `test_native_pulse_fast`, `test_native_pulse_ingress_owner`,
    `test_native_pulse_read_matrix`, `test_native_room_context`.

### Risques
- **Données vers le fournisseur (à confirmer, DATA01).** Les faits Pulse et les réponses remises entrent dans la
  session du contact, donc dans le modèle de son agent. C'est le même fournisseur et le même compte que le cerveau
  d'Amine, mais ce n'est plus l'interprète Gemini admis sous `pulse_interpretation`. À confirmer par Amine avant le
  déploiement.
- **Lectures privées d'Amine.** Comme dans la pièce native, `pulse_room` admet toute lecture Pulse :
  `evaluations.mine`, `finance.ca` et `cra.status` restent accessibles au contact. C'est la politique actuelle,
  inchangée ici.
- **Modèle sans appel d'outil.** Le cerveau peut répondre sans appeler l'outil. Le refus hors de Pulse et l'absence
  d'invention avant appel reposent alors sur l'AGENTS de la pièce et la description de l'outil. Tout résultat Pulse,
  lui, vient de l'outil.
- **Jeton de grant de 30 s.** Le paquet vaut 30 s. Un dry run Pulse lent (jusqu'à 15 s) plus le démarrage Python
  approchent cette borne, comme dans la pièce native. Au-delà, le coordinateur demande une confirmation que la pièce
  ne sait pas recevoir : le contact renvoie sa demande.
- **Pièce Pulse combinée à agenda, actions, messages ou qa** (agents `contacts-pulse-agenda`…). Elle n'est plus
  servie pour Pulse : le grant exige l'agent `contacts-pulse` ou `contacts-projet-pulse`. Aucun grant de ce type sur
  le S24 le 02/11 (bindings : `contacts-projet-pulse` ×2, `contacts-projet` ×1, `contacts` ×1).
- **Grant expiré entre préparation et écriture.** Le hand-off préparé est clos par `abort` ; si `abort` échoue, le but
  reste en hand-off et la récupération D-J le traite au message suivant, sans écriture.

## Déploiement
1. Avant `companion-deploy.sh` : `python3 installer/termux-lite/pulse-room.py provision`, depuis le commit candidat.
   Il ajoute `samantha_pulse` aux deux agents de pièce et ferme le reste. Sans cela, la recette `room_tools` échoue
   et le déploiement revient en arrière.
2. `companion-deploy.sh <commit>`, après activation du commit playbooks apparié `30a92b19`
   (`activate-ui-playbooks.sh <sha>`, branche `claude/room-brain`), car `room_tool_turn` doit exister côté playbooks.
   L'étape CI appariée récupère ce SHA sur GitHub : la branche playbooks doit être poussée avant la CI de ce lot.

## Recette de déploiement (`deploy-parcours.py`)
Les nouveaux chemins, en plus des chemins propriétaires, passent par le runtime déployé : fabrique, preuve, vraie
lecture de grant, vrai helper typé et propriétaire playbooks. Le contact de recette est « Recette Pulse »
(+216 10 000 001, routé vers `contacts-projet-pulse`).
- `room_tools` : politique fermée des deux agents.
- `contact_read` : liste de projets.
- `incomplete_ask` : création incomplète, une question est attendue.
- `room_write_prepared` : changement de statut de phase sur le premier projet de sa liste. Il est préparé, le grant
  est relu, puis le but est clos par `abort`. Le runner n'envoie jamais `handoff`, et le propriétaire playbooks
  n'écrit jamais dans un `call` de pièce : aucune écriture Pulse n'est possible.
- `room_outside` : action d'un autre domaine, refusée.
- `room_leave_refused` : demande de congé, refusée.

Règles de verdict :
- « Pulse est fermé » est valide pour la lecture, la question et l'écriture préparée.
- Si le dry run du propriétaire refuse la cible découverte, le verdict est `inconclusive`. Aucun retour arrière, rien
  n'est écrit.
- Le choix du modèle n'est pas rejoué en recette : c'est ce qui garantit l'absence d'écriture.

## Fixtures
`openclaw-plugin-mobile-ui/fixtures/s24-2026-11-02-pulse-room-brain/`, captures du S24 du 02/11, en lecture seule :
- l'outil `samantha_pulse` projeté par le Graph : 14 des 37 actions, liste complète en provenance ;
- le grant réel du contact de recette ;
- la politique d'outils des deux agents avant ce lot ;
- l'environnement Gateway pertinent (noms et valeurs de drapeaux seulement).

## Retour arrière
- Standard : retour arrière automatique de `companion-deploy.sh` si la recette échoue ; sinon revert du commit puis
  redéploiement. Le plugin revenu rétablit l'interception native : `SAMANTHA_NATIVE_PULSE_HANDOFF=1` est toujours
  dans l'environnement de la Gateway.
- La politique d'outils écrite par `provision` est sans effet avec l'ancien plugin : la fabrique ne donne pas
  `samantha_pulse` aux contacts. Pour rendre `web_search` à `contacts-pulse`, restaurer
  `agents.entries.contacts-pulse.tools` depuis la fixture `agent_tools_before`.
- Playbooks : `activate-ui-playbooks.sh` au SHA précédent ; `room_tool_turn` est un ajout et le chemin propriétaire
  est inchangé.
