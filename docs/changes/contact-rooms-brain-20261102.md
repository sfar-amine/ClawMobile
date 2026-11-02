# Pièces des contacts : le cerveau du contact pour toutes les pièces, interception native retirée — 2026-11-02

Décision d'Amine du 02/11 : « Si quelqu'un est autorisé sur une pièce il peut tout faire dedans. » Étape 4 de la
conversion « Le cerveau partout ». Les pièces agenda, actions et messages, seules ou combinées (entre elles, avec Pulse
ou avec Projet), reçoivent le même cerveau que la pièce Pulse du 02/11 (#522). Il y a un seul chemin, sans bascule par
pièce ni repli natif. ADR : [ADR-20261102-pulse-room-brain](../08-decisions/ADR-20261102-pulse-room-brain.md), section
« Extension à toutes les pièces ».

## Inventaire S24 (02/11, lecture seule, `claw_exec`)
Déployé : core c2a74a44 (#522), playbooks fd2df2b1 (#383).

| Élément | État le 02/11 |
| --- | --- |
| Agents contacts | `contacts` (conversation, `web_search`), `contacts-projet` (`read` sur l'instantané, `web_search`), `contacts-pulse` et `contacts-projet-pulse` (`samantha_pulse` et outils contact, déjà provisionnés) |
| Agents agenda, actions, messages, qa ou combinés | aucun |
| Bindings R17 | `contacts-projet` ×1 (pièce « Projet Samantha »), `contacts-projet-pulse` ×2 |
| Fiches R17 | 3 actives : conversation+projet ×1, conversation+projet+pulse ×2 ; aucune `qaApps` |
| Outils typés (révision 1e0476abc173fceb) | `samantha_pulse`, `samantha_agenda`, `samantha_device_assistance`, `samantha_whatsapp` (et les outils propriétaires) |

Aucun contact réel n'a donc aujourd'hui de pièce agenda, actions, messages ou qa. Ce lot ne change le service d'aucun
contact existant : les deux contacts Pulse et le contact Projet gardent exactement leurs outils et leur politique.

## Conception

### Un modèle, une fabrique, une garde, un principal
- **Modèle** (`contactRoomProfile.ts`) :

  | Pièce | Outil typé | Domaine |
  | --- | --- | --- |
  | `pulse` | `samantha_pulse` | `pulse` |
  | `agenda` | `samantha_agenda` | `agenda` |
  | `actions` | `samantha_device_assistance` | `device-assistance` |
  | `messages` | `samantha_whatsapp` | `whatsapp` |

  - `projet` reste l'instantané de fichiers (`read`, espace de travail seul).
  - `qa` n'a pas d'outil typé (`UNTYPED_ROOMS`, raison `room_domain_not_typed`).
  - `roomAgentFor` reproduit `people-trusted.py room_agent`.
- **Principal** : `room:<pièce>:wa-<16 hex>`, calculé à partir de l'agent routé et de la clé de session WhatsApp
  directe. Ces deux valeurs viennent de l'hôte, jamais du modèle. Pour Pulse, on retrouve exactement
  `room:pulse:wa-…` (#522).
- **Fabrique** (`roomBrain.ts` `createRoomTools`, appelée par la seule fabrique typée de `index.ts`) : une session de
  pièce reçoit l'outil de chaque pièce typée qu'elle porte, et rien d'autre.
  - La liste d'actions comprend les commandes qualifiées du domaine, en lecture, écriture ou envoi. Les candidates,
    les propriétaires navigateur, `confirm` et `cancel` en sont exclus.
  - Chaque outil porte `catalogMode: "direct-only"` et `canDeliverSourceReply`.
  - `pulseRoomBrain.ts` ne garde que les noms #522 (réexport, aucun comportement).
- **Garde** (`capabilityAgentGuard.ts`) :
  - dans toute session contact, un outil `samantha_*` n'est admis que s'il est l'outil d'une pièce que la session
    porte, et jamais avec `senderIsOwner` ;
  - la preuve porte le principal de la pièce de l'outil ;
  - `consumeRoomInvocation` ne l'accepte que pour cet outil-là ;
  - une preuve propriétaire n'est jamais acceptée par un outil de pièce, et inversement.
- **Grant** (`roomGrantPacket`) : lecture people-trusted `allowlistRead get`. Le contact doit être actif, non
  propriétaire, avec ce numéro et cet identifiant, non expiré, routé vers cet agent même (donc avec exactement ces
  pièces), et la pièce de l'appel doit en faire partie.
  - Le grant est lu une fois par message entrant (clé : contact, agent et `runId`), quel que soit l'outil de pièce
    appelé.
  - Il est relu sans cache juste avant chaque écriture.

### Flux d'un message
1. Routage R17 inchangé : un binding concret vers `contacts-<pièces>`.
2. Aucune interception : `before_dispatch` ne traite plus que le propriétaire. `contactRoomFastPath.ts` et ses phrases
   fixes sont retirés.
3. Le cerveau de l'agent du contact choisit l'outil, l'action et les paramètres typés.
4. L'hôte envoie `{command, host, roomAdmission}` sur le stdin privé de `claw-capability.py typed-tool`, avec
   `host.room = <pièce>` et la clé `<pièce>-room:<agent>:<contact>:<session>`.
5. Playbooks `room_tool_turn` : la pièce vient de l'événement admis. La portée est `pulse_room` pour Pulse et
   `room:<pièce>` pour les autres pièces (voir la note playbooks `contact-rooms-brain-20261102`).
   - Une lecture s'exécute.
   - Une écriture est préparée puis arrêtée à son hand-off.
   - Une écriture que le propriétaire récapitulerait (agenda, envoi WhatsApp) est préparée par l'hôte
     (`admit_host_preparation`). La politique de pièce y remplace la question, comme pour Pulse.
6. L'hôte relit le grant puis envoie `handoff` ou `abort`. Restent les garanties des écritures typées : commande
   préparée, exécution unique, vérification par le propriétaire, aucun rejeu après un résultat incertain.
7. La réponse du propriétaire est remise telle quelle. Si le propriétaire ne donne que des faits vérifiés, ces faits
   vont au modèle avec la consigne de n'utiliser qu'eux.

### Actions par pièce
| Pièce | Admis | Refusé avant toute lecture |
| --- | --- | --- |
| Agenda | `agenda.event.read`, `agenda.event.create`, `agenda.event.update`, `agenda.reminder.schedule` | `agenda.sync` (candidate non qualifiée, absente de l'outil) |
| Actions | `device.status.read`, `device.alarm.next`, `device.alarm.set`, `device.dnd.read`, `device.dnd.set`, `device.torch.read`, `device.torch.set`, `device.timer.start`, `device.timer.cancel`, `device.volume.set`, `device.ringer.set`, `device.brightness.set`, `device.battery_saver.set`, `device.bluetooth.set`, `device.wifi.enable`, `device.app.open`, `device.settings.open`, `device.screenshot.take` | `device.sms.latest`, `device.photos.today` (SMS et photos d'Amine, décision du 31/10, `scope_owner_private`) ; `device.modes_routines` (pas de propriétaire typé) |
| Messages | `messaging.send` (au nom d'Amine) | — |
| Pulse | inchangé (#522) | `leave.request` (compte Pulse d'Amine) |
| QA | — | tout : pas de propriétaire typé, aucun outil (`room_domain_not_typed`) |

Hors du domaine de ses pièces, l'appel est refusé (`OUTSIDE_SCOPE`) avec une phrase fixe qui nomme les pièces ouvertes.
Dans une pièce Pulse seule, c'est la phrase #522.

### Consignes et politique d'outils
- `project-room.py room_tool_policy` est l'unique politique d'outils d'un agent de pièce :
  - l'outil typé de chaque pièce et les outils contact ;
  - `read` et `web_search` seulement avec la pièce Projet ;
  - tout le reste dans `deny`.
- Elle est utilisée par `people-trusted.py ensure_room_profile`, quand un grant crée le profil, et par
  `pulse-room.py provision`, qui ferme aussi tout agent de pièce typé déjà présent. Sur les agents Pulse du S24, elle
  ne change rien : point fixe vérifié sur la capture.
- `ROOM_TOOLS_RULE` : une seule consigne, dans `contacts-agent.md` (espace partagé par les agents de pièce clonés de
  `contacts`), dans l'AGENTS de Projet et dans celui de Pulse. Un outil de pièce donné est la seule voie de son domaine,
  et il prime sur les limites générales pour ce domaine seulement. Sans outil, la consigne est inerte. Pulse : « Hors de
  Pulse » devient « Hors de Pulse et des autres pièces dont l'outil t'est donné ».

### Ce qui est retiré
- `src/contactRoomFastPath.ts` (interception `before_dispatch`, `CONTACT_ROOM_REFUSAL`, rendu natif, entrée QA texte et
  pièce jointe des contacts), `scripts/test-contact-room-fast-path.cjs` et son étape CI.
- La partie « ingress de pièce » de `test-qa-private-ingress.cjs`. Le canal privé QA et ses grants restent testés.
- Reste en place sans être utilisé par ce plugin (retrait dans une PR de suite) :
  - playbooks `transition.contact_room_verdict` (portée `contact_room:`), gardée pour un retour arrière du seul core ;
  - `dialogueTurn`/`runModelFastPath` en mode contact (`qaContext`) ;
  - `people-trusted.py qa-ingress-read` ;
  - le code natif Pulse déjà listé par #522.

## Recette de déploiement (`deploy-parcours.py`, sans écriture)
En plus des chemins existants (dont `room_tools`, étendu à tout agent de pièce typé présent), avec le contact de
recette « Recette Pulse » (+216 10 000 001, numéro fictif) :
- `room_generic_tools` : la fabrique déployée donne à la session générique `contacts-agenda-actions-messages`
  exactement `samantha_agenda`, `samantha_device_assistance` et `samantha_whatsapp`.
- `room_generic_read` :
  - si le contact de recette a une pièce agenda ou actions, son agent routé lit (état du téléphone, ou agenda de
    demain) ;
  - sinon (cas du S24 le 02/11), l'outil déployé doit refuser sur la vraie lecture du grant (`room_grant_revoked`),
    sans aucun appel au helper typé.
- `room_generic_outside` : l'outil agenda de la session générique, appelé avec une action Pulse, doit refuser avant
  toute lecture, avec la phrase qui nomme les pièces.

Aucun de ces chemins n'écrit : ce sont des lectures et des refus seulement.

## Fixtures
`openclaw-plugin-mobile-ui/fixtures/s24-2026-11-02-contact-rooms-brain/room-tools.json`, capture S24 du 02/11 en
lecture seule :
- les outils des domaines `agenda`, `device-assistance` et `whatsapp`. Leur sha256 (JSON trié compact) est identique
  sur le S24 et dans la projection des playbooks épinglés fd2df2b1 ; le fichier est écrit depuis cette projection ;
- les politiques d'outils des quatre agents contacts ;
- les bindings R17 par agent ;
- les combinaisons de pièces des fiches, comptées.

La fixture ne contient ni numéro, ni nom, ni identifiant de contact. Les fixtures Pulse #522 sont réutilisées (outil
Pulse, grant du contact de recette).

## Risques
- **Messages** : un contact de la pièce envoie un WhatsApp au nom d'Amine sans confirmation d'Amine à chaque envoi.
  C'est la règle « tout faire dedans » ; le fichier 50 recommandait la confirmation. Question pour Amine.
- **Agenda** : le détail et les écritures sont ouverts. Le fichier 50 prévoyait « libre/occupé » par défaut.
  Question pour Amine.
- **Actions** :
  - La capture d'écran est une écriture admise. Son fichier reste dans la Galerie ; le propriétaire typé ne rend au
    contact que le nom et la taille du fichier.
  - `device.app.open` peut ouvrir une application de la liste fermée, Max it compris. L'ouvrir n'exécute rien : tout
    paiement garde ses gardes humaines (biométrie, OTP).
- **DATA01** : les données de la pièce entrent dans la session du modèle de l'agent du contact (admission acceptée par
  Amine).
- **Modèle sans appel d'outil** : comme pour Pulse, les refus avant appel reposent sur `ROOM_TOOLS_RULE` et les
  descriptions d'outils. Tout résultat, lui, vient d'un outil.
- **QA** : une pièce QA accordée n'exécute plus rien (aucune n'existe sur le S24). La pièce jointe d'un brouillon QA
  existant reste traitée par `qaContactMediaOwner` (`message_received`), inchangé.
- **Fusion avec #524** : #524 retire la partie propriétaire de `before_dispatch`. Ce lot en retire la partie contact.
  Après les deux, le hook disparaît ; la résolution du conflit garde la fabrique typée unique de #524 avec
  `ROOM_TOOLS` et `roomSession`/`createRoomTools`.

## Déploiement (ordre)
1. Playbooks d’abord : `activate-ui-playbooks.sh a77e7359` (branche playbooks `claude/contact-rooms-brain`, à pousser avant la CI de ce lot : l’étape appariée la récupère sur GitHub).
   - Avec l'ancien playbooks, le nouveau plugin refuse les pièces non Pulse (`typed_room_admission_required`) et garde
     Pulse.
   - Avec le nouveau playbooks, l'ancien plugin garde son chemin (portée `contact_room:` conservée).
2. Provisionnement : `python3 installer/termux-lite/pulse-room.py provision`, depuis le commit candidat. Sur le S24 du
   02/11 : `present` (aucun agent de pièce typé hors Pulse ; les deux agents Pulse sont déjà au point fixe).
3. `companion-deploy.sh <commit>` : recette automatique, puis synchronisation des consignes (`contacts-agent.md`,
   AGENTS de Projet et de Pulse) par `runtime-sync.sh`.

## Retour arrière
- Automatique par `companion-deploy.sh` si la recette échoue ; sinon, revert du commit et redéploiement de c2a74a44.
- Le plugin revenu rétablit `contactRoomFastPath` (la portée `contact_room:` reste dans playbooks) et la pièce Pulse
  #522 ; les consignes reviennent par `runtime-sync.sh`.
- Les politiques d'outils écrites par `provision` ou par un grant sont sans effet avec l'ancien plugin (pas d'outil de
  pièce hors Pulse). Pour revenir exactement, restaurer `agents.entries.contacts-*.tools` depuis la fixture
  `room-tools.json`.
- Playbooks : `activate-ui-playbooks.sh fd2df2b1`.
