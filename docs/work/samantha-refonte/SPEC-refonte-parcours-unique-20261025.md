# Samantha — Refonte parcours unique : spécifications pour Codex

Oct 25, 2026 · @Amine

## Résumé et décisions de référence

Ce document demande à Codex de refondre le parcours d'une demande d'Amine pour que texte de l'app, WhatsApp et voix passent par un seul cerveau décideur, qui appelle les actions déterministes comme des outils typés. Chaque lot est validé par une recette finale de Codex en direct sur le S24, puis par Amine en second rideau. Elle garde les routes déterministes, les reçus, la confirmation, la mémoire S24 et la couche voix.

**Décisions d'Amine qui s'imposent (mémoire S24)**

| Date | Événement | Décision |
| --- | --- | --- |
| 25/10 | 3fcf038f… (remplace EVT-3172) | Le cerveau principal est le seul décideur sémantique ; les routes déterministes sont ses outils ; interprète dédié et tri par mots-clés supprimés ; injection et cache avant la bascule ; réponse prête renvoyée telle quelle |
| 25/10 | EVT-3222 | La voix délègue tout au cerveau ; Gemini Live est seulement oreille et bouche |
| 25/10 | décision « On fait tout » (#407) | Attente immédiate, réflexes en liste fermée, avancement rédigé pour Amine, pas de son clavier |
| 22/10 | EVT-3168 | Le code déterministe valide, exécute et vérifie sans réinterpréter ; toute écriture passe par une seule confirmation finale récapitulative |
| 22/10 | EVT-3173 | Le profil Google gratuit peut traiter des données professionnelles ; jamais de payant |
| 10/10 | EVT-1947 | Priorité absolue : corriger l'aiguillage à la racine, registre des capabilities seule source, aucun nouveau routeur ni store |

**Hors périmètre** : le parcours de paiement (inchangé), les étapes humaines (biométrie, codes, 3-D Secure), les agents contacts isolés, le système immunitaire (sauf l'affichage de son modèle). Cible détaillée et schémas : document « Samantha — TO-BE parcours unique et assainissement » du 25/10.

## Constat : parcours actuel

```text
Texte de l'app          WhatsApp d'Amine          Voix
      |                        |                    |
      |                        |             Gemini Live + réflexes
      v                        v                    v
Tri avant le cerveau    Tri avant le cerveau    Décision vocale
Graph par mots-clés     IA (3 domaines) + Graph tri par le Graph
résolu : route directe  résolu : route directe  résolu : route directe
      | non résolu             | non résolu         v
      |                        |              Exécution vocale
      |                        |              nouveau tri, borné à 5 s
      v                        v                    v
            Agent principal (Sol) : relit 6 fichiers de règles
            au démarrage (19 à 21 s, contre 2 à 6 s sans relecture)
                               v
            Outil clawmobile_capability : texte libre, le Graph retrie
                               v
            Routes déterministes : exécution, vérification, reçu
```

Une demande peut être triée avant le cerveau, puis à nouveau par l'outil en texte libre ; en voix, la décision vocale et l'exécution trient chacune une fois de plus. Le tri d'avant le cerveau n'est pas le même selon la surface (à confirmer par trace pour l'app).

## Constat : problèmes et preuves

Douze problèmes ont été constatés le 25/10 dans le code, la config et les traces du S24. Les lignes marquées « à confirmer » viennent du code et doivent être vérifiées par une trace réelle avant d'agir.

| # | Problème | Preuve | Conséquence |
| --- | --- | --- | --- |
| P1 | Double tri en voix | `clawLiveUnderstanding.ts` `clawLiveDecision` résout via le Graph ; `/claw-live/capability` retrie dans `voiceBrainDelegation.ts` `routeUnresolvedVoiceTurn` (résolution bornée à 5 s) | latence, deux décisions pour un tour |
| P2 | Tri différent selon la surface (à confirmer) | l'interprète IA est actif sur le S24 (`SAMANTHA_INTENT_INTERPRETER=1`) mais exclu pour la surface `claw_live` (`model-fast-path.py`, l. 1471), utilisée par l'app et la voix d'après `modelFastPath.ts` ; WhatsApp et MCP l'utilisent | même phrase, résultat différent selon la surface |
| P3 | Bascule vers le tri IA partielle | EVT-3199 (24/10) : seules l'accès PC, l'envoi WhatsApp et la création d'agenda basculés ; retrait du code par mots-clés non fait | erreurs d'aiguillage de l'ancien tri |
| P4 | Outil Samantha en texte libre | `capabilityTool.ts` : `clawmobile_capability(request: string)` ; le Graph retrie le texte derrière le cerveau | double décision cachée, paramètres non typés |
| P5 | Relectures au démarrage | course `run_1792920553461_9ffdf172` (25/10, 10:29) : `request_context.py` puis 6 lectures (`OPERATING_RULES.md`, `interaction-fast-path.md`, `manifest.json`, `engineering.md`, `memory.md`, `HYBRID_CONTEXT.md`) ; mesures `trajectory_runtime_events` : 2,3 à 6,3 s sans relecture, 19 à 21 s avec | lenteur sur toutes les surfaces |
| P6 | Contexte lourd | `claw_context` du 25/10 : environ 15 256 jetons estimés pour une cible de 6 000 | coût, latence, attention diluée |
| P7 | Avancement illisible | écran de l'app (25/10, 10:29) : 6 « Reading files · done » et « Internal tool » ; une seule `progress_card` au S24, de septembre ; corrigé par #407 et #312 (non déployés) sauf quand l'agent n'écrit pas de carte | Amine ne sait pas ce qui se passe |
| P8 | Délais différents par surface | WhatsApp `timeoutSeconds: 75` (`handleOwnerFastPath`) ; voix : budget cerveau 30 s puis relecture différée | expérience hétérogène |
| P9 | Réglages des modèles éparpillés | `openclaw.json` (agents `main`, 4 contacts, `engineering-lite`, `gemini`, compaction, recherche mémoire, voix lue) ; `model_policy.json` (système immunitaire, interprète, ingénierie) ; constantes dans le code (`gemini-3.8-live` dans `clawLive.ts`, `gemini-3.5-flash-lite` dans `memoSttBoundary.ts`, `runWeb.ts`, `intentInterpreterPort.ts`, `interpretation_gateway.py`) ; l'app n'écrit que l'agent `main` (R6) | impossible de régler un flux sans PR |
| P10 | Retours non mesurés | le propriétaire `POST /v1/learning/not-this` (lot 38 A2) et la carte Contrôle › Compréhension existent, mais aucun appel n'est trouvé dans les sources de l'app (à confirmer) : `ReplyUnderstanding.kt` envoie seulement un texte de correction | le taux « Ce n'est pas ça » de la carte reste sans données |
| P11 | 12 PR Codex ouvertes | sfar-amine/samantha-core #382 à #395 (chantier 1, 22–23/10), état inconnu | risque de travail en double ou écrasé |
| P12 | Erreurs vues en réel | « Bonjour Samantha » classé `samantha.app.catalog` (REQ-3224, ouvert) ; factures 24/10 : Gemini indisponible puis proposition de Luna invalide (corrigé par le format strict, PR311) | confiance d'Amine |

## Objectifs et critères d'acceptation

Six objectifs, chacun mesuré ; les seuils sont proposés et deviennent définitifs après validation d'Amine et la mesure de référence (L1).

| Objectif | Mesure | Seuil proposé |
| --- | --- | --- |
| O1 Se tromper rarement | scénarios de recette : bonne action et bons paramètres, ou question quand c'est ambigu ; taux « Ce n'est pas ça » de la carte Compréhension | 100 % des scénarios de recette ; zéro écriture sans confirmation ; zéro fait inventé ; « Ce n'est pas ça » en baisse |
| O2 Rapide | temps avant le premier signe de vie ; temps avant la réponse utile (médiane, 95e centile) | signe de vie < 1 s ; question simple < 6 s en médiane ; autres seuils fixés après la mesure de référence |
| O3 Homogène | scénarios de recette joués en texte, WhatsApp et voix | même décision sur les trois surfaces pour 100 % des scénarios |
| O4 Simple | couches supprimées (interprète dédié, tri par mots-clés, double tri voix, relectures, outil en texte libre) | toutes supprimées ; aucun nouveau registre, routeur, store ou planificateur |
| O5 Réglable | modèle, effort, secours et vitesse par flux depuis l'app | flux « dès ce lot » modifiables, avec reçu et retour arrière |
| O6 Livrer vite et sûr | recette finale de Codex en direct sur le S24, puis Amine en second rideau | recette finale verte avant clôture ; retour arrière en un geste |

## Cible et lots

La cible : entrée (texte, WhatsApp, voix avec sa seule couche propre) → cerveau principal seul décideur, contexte injecté et en cache → outils déterministes typés, question, ou réponse directe → réponse avec avancement rédigé pour Amine → mémoire S24. Schéma et arborescence des réglages : Samantha — TO-BE parcours unique et assainissement.

| Lot | Contenu | Dépend de | Dépôts |
| --- | --- | --- | --- |
| L0 Prérequis | livrer #407 et #312 ; finir le lot APK voix v2 (branche `claude/voice-progress-readback-20261025`, f180e922) ; trier les 12 PR Codex | — | core, playbooks, app |
| L1 Mesure de référence et recette | scénarios de recette par lot, mesure de référence, bouton « Ce n'est pas ça » branché sur son propriétaire | L0 | core, app, playbooks |
| L2 Socle injecté et skills | fin des relectures ; modules de règles convertis en skills ; cache | L1 (mesure avant/après) | playbooks, core, config S24 |
| L3 Cerveau seul décideur | outils typés par domaine, catalogue par recherche, réponse prête ; suppression de l'interprète dédié, du tri par mots-clés, du double tri et de l'outil en texte libre | L1, L2 | core, playbooks |
| L4 Voix, budgets, mesure | un seul parcours voix ; budget commun ; ligne de mesure commune aux trois surfaces | L3 | core, app |
| L5 Modèles par flux | écran hiérarchisé avec héritage, garde-fous et reçus | L3 | core, app, playbooks |
| L6 Avancement sans carte | titres écrits par l'agent, plus aucun nom d'outil | #407 | core, app |

## Fonctionnel L1 — Mesure de référence et recette finale

Pas de banc d'essai (décision d'Amine, 25/10 12:34) : chaque lot se clôt par une recette finale menée par Codex en direct sur le S24, puis Amine vérifie en second rideau.

### Recette finale de chaque lot

- Une liste de scénarios réels par lot, tirée de ses critères d'acceptation, exécutée en direct sur le S24 et sur chaque surface concernée.
- Preuves pour chaque scénario : la trace de l'agent, la ligne de mesure du tour et le reçu. Résultat joint à la PR et inscrit dans la mémoire S24.
- Les écritures s'arrêtent à la confirmation, sauf scénario explicitement autorisé par Amine ; jamais de paiement.
- Un lot n'est clôturé qu'avec une recette finale verte.

### Scénarios communs minimum

1. « C'est quoi mon solde Orange ? » en texte, WhatsApp et voix.
2. Lecture d'une facture (STEG ou SONEDE).
3. Création d'un rendez-vous d'agenda, arrêtée au récapitulatif.
4. Envoi WhatsApp à un contact, arrêté au récapitulatif.
5. Lecture Pulse.
6. Accès PC.
7. Question ouverte (réponse du cerveau, aucune action).
8. Demande ambiguë (« Rappelle-moi demain ») : une question précise.
9. Demande inconnue : aucun fait inventé.
10. « Bonjour Samantha » en voix : réflexe, rien d'exécuté.
11. Interruption d'Amine pendant l'attente vocale.
12. Réponse au-delà du budget : livraison différée sur la même surface.

### Mesure de référence

Avant L2, les mêmes scénarios sont joués sur l'état actuel et leurs durées enregistrées (signe de vie, réponse utile), pour comparer après chaque lot sur des faits.

### « Ce n'est pas ça »

Le propriétaire existe déjà côté Companion (`POST /v1/learning/not-this`, lot 38 A2), avec la carte Contrôle › Compréhension qui compte les gestes. L'app ne semble pas l'appeler (à confirmer) : le bouton de l'app est branché sur ce propriétaire, sans nouveau store. Un problème trouvé par Amine en second rideau devient un scénario de la recette du lot suivant.

### Critères d'acceptation L1

- [ ] La liste de scénarios par lot est dans le dépôt et exécutable par Codex, avec ses preuves.
- [ ] La mesure de référence est enregistrée avant L2.
- [ ] Le bouton « Ce n'est pas ça » de l'app appelle `/v1/learning/not-this` ; la carte Compréhension compte le geste.
- [ ] Aucune écriture réelle ni paiement pendant une recette sans accord explicite d'Amine.

## Fonctionnel L2 — Socle injecté et skills

Le cerveau commence chaque conversation avec un socle court déjà présent, sans relire de fichier, et ne lit un savoir-faire que quand la tâche le demande.

### Le socle, toujours présent

- **Contenu** : identité et ton (`SOUL.md`), lignes rouges (`AGENTS.md`), règles d'exploitation essentielles (ne jamais inventer, une confirmation pour toute écriture, étapes humaines, paiement), vue mémoire bornée (contraintes actives, sujets ouverts, activité récente).
- **Taille** : au plus 6 000 jetons, la cible déjà fixée pour le contexte Claw.
- **Empreinte** : le socle porte son empreinte et la révision de mémoire. Le cerveau sait qu'il l'a déjà et ne relit rien.
- **Réduction** : chaque règle du socle doit venir d'une décision d'Amine ou d'un échec réellement observé ; les doublons partent ; quelques exemples valent mieux qu'une longue liste de cas.
- **Même socle** pour l'app, WhatsApp, le cerveau de la voix et les sessions OpenClaw natives d'Amine. Les surfaces externes (ChatGPT, Claude, Codex) reçoivent le même contenu par `claw_context`.

### Les skills, lus à la demande

- Les modules de règles (`engineering`, `mobile`, `routes`, `channels`, `reporting`, `workspace`, `memory`) et le détail de la procédure de `interaction-fast-path.md` deviennent des skills au standard Agent Skills : un nom et une description courte toujours visibles, le corps lu seulement quand la tâche correspond.
- Les 4 skills existants (agenda, factures, télécom, recette) restent et sont alignés sur le même format.
- Le choix d'un skill se fait par le cerveau, sur sa description ; plus de sélection par mots-clés.

### Fraîcheur

Si une règle ou la mémoire change pendant une conversation, le cerveau lit seulement le delta, par la barrière de révision existante.

### Critères d'acceptation L2

- [ ] Sur une nouvelle conversation, la trace ne montre aucune lecture des 6 fichiers de démarrage ; le premier outil appelé sert la tâche.
- [ ] Le socle mesuré fait au plus 6 000 jetons.
- [ ] Un skill n'est lu que sur une tâche qui le concerne (trace).
- [ ] La recette finale passe et fait au moins aussi bien que la mesure de référence ; les tests de comportement passent : ne jamais inventer, « Bonjour Amine », paiement et biométrie, isolement des contacts.
- [ ] Une question simple a une médiane ≤ 6 s (contre 19 à 21 s aujourd'hui).
- [ ] Une règle modifiée en cours de conversation est prise en compte par lecture du delta.

## Fonctionnel L3 — Cerveau seul décideur et outils par domaine

Toute demande d'Amine arrive au cerveau principal, qui décide seul : il appelle un outil déterministe typé, pose une question précise, ou répond directement.

### Entrée

- Texte de l'app, WhatsApp d'Amine et voix arrivent au cerveau sans tri préalable.
- Seules exceptions, qui ne décident jamais du sens d'une phrase : les réflexes vocaux en liste fermée (#407), et les gestes explicites de l'app (bouton de confirmation, choix touché dans une liste).

### Outils par domaine

- Une dizaine d'outils, un par domaine, préfixés `samantha_` : télécom, factures, agenda, tâches, WhatsApp, Pulse, appareil, notifications, accès PC, web. La liste exacte sort du registre et des manifestes.
- Chaque outil liste ses actions et leurs paramètres typés (opérateur, période, contact, montant…), avec 1 à 5 exemples d'appel.
- Chaque réponse d'outil est courte et utile : l'état, les faits du reçu, et une réponse prête quand la route en fournit une. Une erreur dit quoi faire, jamais un code opaque.
- Le reste du catalogue (91 capabilities) est trouvé par une recherche, à la demande.
- Les agents contacts gardent leurs seuls outils (`transmettre_a_amine`, `noter_contact`) ; ils n'ont jamais accès aux outils Samantha.

### Réponse prête

Quand la route fournit une réponse prête (solde, facture, statut), elle est renvoyée telle quelle, sans second tour de modèle. Le texte est celui du reçu.

### Confirmation des écritures

- Une écriture renvoie d'abord un récapitulatif (action, cible résolue, paramètres) et un identifiant de confirmation.
- Amine confirme par un bouton dans l'app, ou par une réponse sur WhatsApp ou en voix que le cerveau transmet comme confirmation de cet identifiant.
- L'exécution reprend exactement le contenu récapitulé ; si quoi que ce soit a changé, elle est refusée et un nouveau récapitulatif est demandé.
- Paiement, biométrie, OTP et 3-D Secure : inchangés.

### Ambiguïté

Le cerveau pose une seule question précise et reprend au même point quand Amine répond.

### Ce qui disparaît

L'interprète dédié (Gemini puis Luna), le tri par mots-clés du Graph, la décision vocale qui retrie, et l'outil `clawmobile_capability` en texte libre.

### Critères d'acceptation L3

- [ ] Une trace par surface montre une seule décision par tour, prise par le cerveau, et aucune résolution du texte par le Graph.
- [ ] Les scénarios de recette passent (O1), avec la même décision sur les trois surfaces (O3).
- [ ] Toute écriture passe par un récapitulatif ; une confirmation dont le contenu a changé est refusée.
- [ ] Une réponse prête ne déclenche pas de second tour de modèle (trace).
- [ ] « Bonjour Samantha » ne déclenche jamais une action du catalogue.
- [ ] Le code supprimé n'existe plus ; ses tests sont retirés ou remplacés.
- [ ] Les agents contacts n'ont accès à aucun outil Samantha (test).

## Fonctionnel L4 — Voix, budget commun, mesure par tour

La voix suit le même parcours que le texte, toutes les surfaces ont le même budget de délai, et chaque tour laisse une mesure comparable.

### Voix

- Gemini Live entend et parle ; les réflexes en liste fermée répondent seuls ; tout autre tour va directement au cerveau, sans décision vocale intermédiaire.
- Pendant l'attente : phrase d'attente locale immédiate, relances vers 8 s et 20 s, étapes de la carte d'avancement dites à voix haute, arrêt immédiat de tout cela quand Amine reprend la parole. Ce comportement est celui du lot APK voix v2 (L0), qui doit être livré avant.
- La réponse prête est lue mot pour mot quand elle fait moins de 600 caractères (règle actuelle) ; au-delà du budget, Samantha annonce qu'elle revient et lit la réponse dès qu'elle arrive.

### Budget commun aux trois surfaces

| Moment | Voix | App | WhatsApp |
| --- | --- | --- | --- |
| Signe de vie, moins de 1 s | phrase d'attente locale | indicateur et étape en cours | indicateur « en train d'écrire » |
| Au-delà de 20 s sans réponse | relance dite avec l'étape en cours | étape en cours affichée | un court message avec l'étape en cours (proposition, Q5) |
| Au-delà du budget de réponse (proposé : 30 s, Q5) | « je reviens vers toi », puis lecture différée | réponse différée dans la conversation | réponse différée dans le même fil |

Aujourd'hui WhatsApp attend jusqu'à 75 s et la voix 30 s ; le budget devient le même partout.

### Mesure par tour

- Chaque tour, sur chaque surface, écrit une seule ligne de mesure : surface, voie prise (outil, question, réponse directe, réflexe), modèle, durées (signe de vie, décision, outil, réponse utile, total). Jamais le texte de la demande ni de la réponse.
- La ligne `[voice-turn]` de #407 devient cette ligne commune.
- L'onglet Contrôle affiche la médiane et le 95e centile par surface.

### Critères d'acceptation L4

- [ ] Une trace vocale montre le tour envoyé au cerveau sans résolution par le Graph ; les réflexes sont inchangés.
- [ ] Le signe de vie arrive en moins de 1 s sur les trois surfaces (mesure).
- [ ] Le même budget s'applique partout ; une réponse différée arrive sur la même surface et dans le même fil.
- [ ] Chaque tour écrit exactement une ligne de mesure, sans texte (test sur les trois surfaces).
- [ ] Amine qui parle pendant l'attente coupe la phrase d'attente, les relances et l'avancement.

## Fonctionnel L5 — Écran des modèles par flux

Dans Réglages, un écran « Modèles par flux » montre chaque flux, d'où vient son réglage, et permet de changer modèle, effort, secours et vitesse là où c'est permis. Il remplace l'écran actuel « Modèle de l'agent ».

### Flux affichés (valeurs du 25/10)

| Flux | Groupe | Aujourd'hui | Modifiable |
| --- | --- | --- | --- |
| Cerveau principal | — | GPT-5.6 Sol, réflexion basse, vitesse prioritaire ; secours Terra, Luna, Gemini Flash-Lite gratuit, Copilot GPT-4.1 | oui (L5) |
| Recherche web | Cerveau principal | Gemini Flash-Lite gratuit, dans le code | lot suivant |
| Résumé des conversations | Mémoire | GPT-5.6 Luna | oui (L5) |
| Recherche mémoire | Mémoire | Gemini | lot suivant |
| Voix de Samantha | Voix | Gemini Live (`gemini-3.8-live`), dans le code | lot suivant |
| Lecture à voix haute | Voix | Microsoft, voix Denise | lot suivant |
| Dictée en direct | Voix › Retranscription | reconnaissance Google du téléphone | lecture seule |
| Mémos vocaux | Voix › Retranscription | Gemini Flash-Lite, dans le code | lot suivant |
| Système immunitaire | — | Sol puis Luna (`model_policy.json`) | lot suivant |
| Ingénierie et apprentissage | Système immunitaire | Sol (agent `engineering-lite`) | lot suivant |
| WhatsApp (contacts et Amine) | — | Sol, réflexion basse, vitesse prioritaire | oui (L5) |

### Règles

- **Priorité** : réglage de la conversation (existant) > réglage du flux > défaut Samantha. Chaque réglage affiche son origine (« hérité de… ») et un bouton « Revenir à l'hérité ».
- **Sur un flux modifiable** : fournisseur et compte, modèle (liste permise pour ce flux), secours dans l'ordre, réflexion (niveaux proposés par le modèle), vitesse prioritaire.
- **En lecture** : état du fournisseur et quota, taux de « Ce n'est pas ça » et latence médiane du flux sur 7 jours (L1, L4), pour choisir sur des faits.
- **WhatsApp** : le réglage s'applique aux 4 agents contacts et aux sessions WhatsApp d'Amine, pour le modèle, l'effort et la vitesse seulement ; la mémoire et les droits d'Amine ne changent pas.
- **Garde-fous** : seulement les abonnements et profils gratuits (ChatGPT, Google gratuit, Copilot), aucune facturation API ; biométrie pour un nouveau fournisseur ou compte ; effet sur les nouvelles sessions uniquement ; un reçu par changement ; « Revenir à la version précédente » en un geste ; chaque changement inscrit dans la mémoire S24.

### Critères d'acceptation L5

- [ ] Les 11 flux s'affichent avec leurs valeurs réelles et leur origine.
- [ ] Cerveau principal, résumé et WhatsApp se modifient avec reçu ; une session déjà en cours garde son modèle.
- [ ] Un secours d'un autre fournisseur exige la biométrie.
- [ ] Un modèle payant à l'usage n'est jamais proposé.
- [ ] « Revenir à la version précédente » restaure exactement l'état d'avant.
- [ ] Un changement WhatsApp n'ouvre aucun accès des contacts au contexte d'Amine (test).

## Fonctionnel L6 — Avancement lisible sans carte

Quand l'agent n'écrit pas de carte d'avancement, l'app montre quand même des étapes compréhensibles, jamais un nom d'outil.

- Une étape prend le titre que l'agent donne à sa commande quand il existe (exemple réel du 25/10 : « Lire le checkpoint Voix v2 », « Vérifier le statut actuel de la PR 407 »).
- Les lectures de contexte du démarrage ne s'affichent jamais ; au plus une ligne « Je prépare ta demande » (elles disparaissent avec L2).
- Des étapes identiques qui se suivent sont fusionnées en une seule.
- Aucun nom d'outil (`exec`, `read`, `tool_search`, `memory_search`…), de fichier ni de commande n'apparaît.
- Une étape terminée n'a plus l'icône « en cours » (défaut vu le 25/10 sur la dernière ligne).
- La carte rédigée par l'agent (#407, #312) garde la priorité quand elle existe.

### Critères d'acceptation L6

- [ ] Sur la capture réelle de la course `run_1792920553461_9ffdf172`, l'app affiche les titres de l'agent, sans « Reading files » ni « Internal tool ».
- [ ] Une étape terminée n'affiche jamais l'icône « en cours ».
- [ ] Avec une carte présente, la carte est affichée et les titres ne le sont pas.

## Technique L1 — Recette finale, mesure de référence, « Ce n'est pas ça »

Tout s'appuie sur des propriétaires existants : la recette de `companion-deploy.sh`, les traces OpenClaw, les runs du Companion et le propriétaire d'apprentissage.

### Scénarios de recette

- **Format** : un fichier JSON versionné par lot dans `samantha-core`, à côté des fixtures existantes. Une entrée : `id`, `surfaces[]` (`app`, `whatsapp`, `voice`), `phrase`, `expected` (`route`: `tool` | `question` | `answer` | `reflex` ; `capability` et `params` si `tool`), `safety` (`stopAtConfirmation: true` par défaut ; `allowWrite` seulement avec l'accord d'Amine cité).
- **Exécution** : réutiliser le propriétaire de recette existant, `installer/termux-lite/companion-acceptance.py` lancé par `companion-deploy.sh`, ou la recette nocturne existante. Codex vérifie lequel couvre des scénarios en direct avant d'en étendre un ; aucun nouveau lanceur si l'un convient.
- **Preuves par scénario** : l'identifiant de course OpenClaw (`trajectory_runtime_events`), la ligne de mesure du tour (L4, ou `[voice-turn]` en attendant), l'identifiant de reçu. Résumé joint à la PR et inscrit par `context-event.sh` (`completed_action`), jamais de transcript.

### Mesure de référence

- Sources en lecture seule : `~/.openclaw/agents/main/agent/openclaw-agent.sqlite` (table `trajectory_runtime_events` : `session.started`, `tool.call`, `model.completed`), les runs du Companion (`runs.ts`, heures d'admission et de fin), et `[voice-turn]` pour la voix.
- Calcul par scénario : signe de vie, décision, outil, réponse utile, total. Résultat en JSON joint au lot L1 ; aucun nouveau store.

### Brancher « Ce n'est pas ça »

- App : le geste de `ReplyUnderstandingRow.kt` et de `RunJourneyUi.kt` appelle `POST /v1/learning/not-this` avec `{operationId, runId}`, en loopback et avec l'en-tête `x-clawmobile-owner-flow: v1` exigé par la route (`server.ts`, garde 38 A2). L'effet actuel (texte de correction ou réalignement guidé) est conservé.
- `operationId` stable par geste et par run : un nouvel essai rejoue le même reçu (`already_recorded`).
- Companion : aucun changement de propriétaire (`learning.ts` → `python3 -m reporting.control_learning not-this`, `improvements.db`) ; la carte Compréhension (`control-health.ts` `projectComprehension`) compte déjà `notThisAt`.

### Tests

- App : test JVM de la requête (route, en-tête, idempotence) ; test Compose du bouton.
- Companion : `scripts/test-learning-routes.cjs` étendu au cas appelé depuis l'app, sur capture S24 réelle d'un run.
- Scénarios : validation de schéma en CI (`ci.yml`) ; exécution en direct seulement sur le S24.

### Route, budget, capability

`POST /v1/learning/not-this` existe déjà : budget et capability inchangés (route d'écran propriétaire). Aucune route nouvelle dans ce lot.

## Technique L2 — Socle injecté, cache, skills

Les relectures viennent des instructions elles-mêmes : `AGENTS.md` (bloc `CONTEXT_RULES_COMPACT_V1`) et le bloc géré `INTERACTION_FAST_PATH_V1` de `OPERATING_RULES.md` demandent de lancer `request_context.py` et de lire les fichiers de démarrage. On garde le contenu, on change le moment où il arrive.

### Socle

- **Source unique** : un fichier socle généré dans `samantha-ui-playbooks` à partir de `SOUL.md`, des lignes rouges d'`AGENTS.md`, des règles essentielles d'`OPERATING_RULES.md` et de la vue mémoire bornée de `HYBRID_CONTEXT.md`. En-tête : empreinte SHA-256 et révision mémoire.
- **Ordre** : partie stable d'abord (identité, règles), partie qui change ensuite (vue mémoire), pour que le cache du fournisseur porte sur la partie stable.
- **Budget** : 6 000 jetons au plus, mesuré avec l'estimateur de `claw_context` (octets / 4). Un test échoue au-delà.
- **Injection** :
  1. sessions OpenClaw d'Amine (WhatsApp, natif) : par les fichiers de démarrage qu'OpenClaw injecte déjà ;
  2. sessions du Companion (app, cerveau de la voix) : par `compactOwnerAgentContext` (`clawLive.ts`) et l'injection du chat, qui insèrent le socle et son empreinte ;
  3. surfaces externes : `claw_context` renvoie le socle et l'index des skills au lieu des 7 lectures obligatoires.
- **Preuve d'injection** : `request_context.py` connaît déjà une liste `bootstrap.injected` par surface ; elle est étendue au socle. Quand l'empreinte injectée est la bonne, plus aucune lecture n'est requise.
- **Instructions** : `AGENTS.md` et le bloc `INTERACTION_FAST_PATH_V1` (`tools/install_interaction_rules.py`) sont réécrits pour « utiliser le socle injecté ; lire un skill seulement si la tâche le demande ; lire le delta si la révision change ».

### Skills

- Les modules de `context/rules/manifest.json` (`engineering`, `memory`, `routes`, `channels`, `mobile`, `reporting`, `workspace`) et le détail de `docs/07-engineering/interaction-fast-path.md` deviennent des dossiers `SKILL.md` au standard Agent Skills (frontmatter `name`, `description` ; corps de moins de 500 lignes ; ressources à part).
- Emplacement : le dossier de skills de l'espace de travail chargé par OpenClaw (à vérifier sur la version 2026.9.6 du S24), alimenté par l'activation des playbooks.
- Les 4 skills existants (`agenda`, `billing`, `telecom`, `qa_testing`) sont alignés sur le même format.
- La sélection par expressions régulières de `manifest.json` et la lecture obligatoire de `interaction-fast-path.md` sont retirées une fois les skills en place.

### Fraîcheur

La barrière de révision existante (`context-head.sh`, `context-barrier.sh`) compare la révision du socle injecté à la révision courante et ne renvoie que le delta.

### Tests

- Playbooks : taille du socle, présence des règles non négociables (ne jamais inventer, « Bonjour Amine », paiement, étapes humaines, isolement des contacts), preuve d'injection qui supprime les lectures, frontmatter des skills ; inscrits dans `documentation.yml`.
- Core : injection du socle et de son empreinte dans les contextes du chat et de la voix ; inscrits dans `ci.yml`.
- Recette : trace d'une nouvelle session sans lecture de démarrage, sur les trois surfaces.

### Parité MCP et retour arrière

- Mettre à jour l'adaptateur `claw_context` et sa documentation (règle de parité MCP d'`OPERATING_RULES.md`).
- Retour arrière : réépingler le SHA précédent des playbooks avec `activate-ui-playbooks.sh`, puis `companion-deploy.sh` du commit précédent.

## Technique L3 — Outils typés, catalogue, suppressions

Le cerveau produit directement la décision que le contrat V2 (08/10) attend : une `DecisionEnvelope` immuable. Le chemin déterministe existant la valide et l'exécute sans la résoudre à nouveau.

### Outils par domaine

- **Générés, jamais écrits à la main**, à partir de `capabilities/registry.json` (91 entrées) et de `skill_intelligence/manifests/*.json` (11 domaines), à l'activation des playbooks. Pas de second catalogue.
- **Enregistrés** par le plugin (`openclaw-plugin-mobile-ui/src/index.ts`, `api.registerTool`), comme `clawmobile_capability` aujourd'hui. Un outil par domaine, nommé `samantha_<domaine>`.
- **Schéma strict** : `action` (énumération des actions du domaine) et `params` (un schéma par action, types et valeurs permises issus du manifeste) ; `additionalProperties: false`.
- **Description** : rôle de l'outil, quand l'utiliser, et 1 à 5 exemples d'appel. Les exemples vont dans la description si le fournisseur n'a pas de champ dédié.
- **Exposition** : seules les capabilities `e2e_validated`, `operational` et `implemented` ; `planned` et `experimental` exclues ; `degraded` signalée dans la réponse.
- **Réponse** : `{state, receiptId, facts, answer?, confirmation?}`. `answer` est la réponse prête du reçu ; `confirmation` vaut `{confirmationId, recap, payloadHash}` pour une écriture. Une erreur donne la cause et l'action possible.

### Catalogue à la demande

OpenClaw dispose déjà de `tool_search` et `tool_call` (vus dans la trace du 25/10). Codex vérifie qu'ils couvrent les outils du plugin en chargement différé. Sinon, un outil `samantha_catalogue` `{query}` renvoie les meilleures capabilities avec leur signature d'appel.

### Réponse prête

Une réponse prête doit pouvoir finir le tour sans second appel au modèle. Le mécanisme est à vérifier dans OpenClaw 2026.9.6 (fin de tour par un outil, ou crochet du plugin après le résultat d'outil). À défaut, le second tour reste, avec un modèle rapide, et Codex le signale.

### Confirmation

- Réutiliser le propriétaire `/v1/confirmations` (routes `challenge`, `owner-confirmation`) et sa règle `payloadHash` (SHA-256 du JSON ordonné, déjà utilisée par R6).
- Le cerveau confirme par l'action `confirm` de l'outil avec `confirmationId` ; l'app confirme par son bouton. L'exécuteur refuse si le hash a changé.
- Le parcours de paiement garde ses routes et ses gardes, sans modification.

### Entrée par surface

- **WhatsApp d'Amine** : `handleOwnerBeforeDispatch` (`modelFastPath.ts`) n'intercepte plus le tour pour un tri préalable ; le tour va à l'agent. Cela remplace le choix du 12/10 (« même pour moi il ne faut pas passer par le modèle ») ; voir Q1.
- **App** : le chat du Companion envoie le tour à l'agent sans `runModelFastPath` préalable.
- **Voix** : voir L4.
- **Hors périmètre, inchangés** : les salles Pulse natives (`nativePulse`), les agents contacts et leurs outils.

### Suppressions, après recette verte

- **Interprète dédié** : `SAMANTHA_INTENT_INTERPRETER`, `intentInterpreterPort.ts`, `interpretation_gateway.py`, `interpretation_data.py`, le profil `INTENT_INTERPRETATION` de `model_policy.json`, `interpret_turn` du coordinateur.
- **Tri par mots-clés** : le reclassement lexical du Graph (`ports.resolve` sur le texte).
- **Décision vocale qui retrie** : l'appel au Graph dans `clawLiveDecision` et la résolution de `routeUnresolvedVoiceTurn`.
- **Outil en texte libre** : `clawmobile_capability` ; les outils MCP externes `claw_resolve` et `claw_execute` acceptent aussi l'appel typé (parité MCP).

### Bascule

Un interrupteur d'hôte (variable d'environnement, jamais un champ client) active le nouveau chemin. L'ancien est supprimé dans la PR suivante, après recette verte : pas de double chemin permanent.

### Tests

- Génération : chaque capability exposée a un schéma et des exemples valides.
- Contrat : appel typé → `DecisionEnvelope` → exécution sur captures S24, sans appel à la résolution du texte (espion).
- Confirmation refusée si le hash change ; isolement des contacts ; réponse prête.
- Les tests du code supprimé sont retirés ou remplacés ; tout est inscrit dans `ci.yml` et `documentation.yml`.

## Technique L4 — Voix, budget commun, ligne de mesure

La voix perd sa décision intermédiaire, les trois surfaces partagent une constante de budget et un format de mesure, portés par les runs existants.

### Voix

- `/v1/extensions/claw-live/decision` (`clawLiveUnderstanding.ts`) : garder le test des réflexes (`voiceReflex.ts`) ; pour tout autre tour, renvoyer la décision prise en charge par le Companion (`success: true`, `voiceFastPath {version: 1, execute: true, owner: "samantha_brain"}`, introduite par #407 pour les tours de raisonnement) sans appeler le Graph.
- `/v1/extensions/claw-live/capability` : le tour va directement à `delegateVoiceTurnToBrain` (`voiceBrainDelegation.ts`), sans la résolution de `routeUnresolvedVoiceTurn`.
- Contrat de Gemini Live inchangé (délégation au cerveau v2, lecture mot pour mot).
- **Prérequis L0 (lot APK voix v2)** :
  - `VoiceOptionAPolicy` reconnaît `owner == "samantha_brain"` ;
  - suivi de l'avancement par `runByClient("voice-cap-" + turnId)` puis `api.run(id)` toutes les 1,5 s ;
  - contrôle `speakProgress` du protocole v2 (branche `claude/voice-progress-readback-20261025`, f180e922 : 6 phrases de 200 caractères au plus par tour, annoncé par `progressReadback: 1` dans `warmReady`) ;
  - relances vers 8 s et 20 s, variantes de `VoiceClipCache`, arrêt sur reprise de parole, `awaitReadback` pour le différé.

### Budget commun

- Une seule constante de budget dans le Companion, utilisée par les trois chemins : `handleOwnerFastPath` (aujourd'hui `timeoutSeconds: 75`), le budget du cerveau en voix (30 s dans `voiceBrainDelegation.ts`) et l'attente du chat de l'app. Valeur proposée : 30 s (Q5).
- Livraison différée par les propriétaires existants : runs du Companion pour l'app ; file sortante durable d'OpenClaw pour WhatsApp (même fil) ; `awaitReadback` puis `speakResult` pour la voix.
- Signe de vie : phrase d'attente locale en voix ; état « accepté » et étape en cours dans l'app ; indicateur de frappe sur WhatsApp, via le réglage du canal OpenClaw (à vérifier).

### Ligne de mesure commune

- Les durées sont ajoutées aux runs stockés par `runs.ts` (propriétaire existant) : `firstSignMs`, `decisionMs`, `toolMs`, `usefulMs`, `totalMs`, plus `surface`, `route` (`tool` | `question` | `answer` | `reflex`) et le modèle.
- Leur projection est une ligne de journal par tour, qui remplace `voiceTurnLogLine` : `[turn] surface=… route=… model=… first_sign_ms=… decision_ms=… tool_ms=… useful_ms=… total_ms=…`. Jamais de texte.
- Pour WhatsApp, la fin de tour est observée par un crochet du plugin (à choisir parmi ceux d'OpenClaw 2026.9.6).
- L'onglet Contrôle lit la médiane et le 95e centile par le propriétaire de santé existant (`control-health.ts`), comme `projectComprehension`.

### Tests

- Décision vocale sans appel au Graph (espion) ; réflexes inchangés.
- La même constante de budget est utilisée par les trois chemins ; livraison différée par surface.
- Une ligne de mesure exactement par tour, sans texte, sur captures S24 des trois surfaces.
- Tests JVM du lot APK (`VoiceProgressPolicy`) et du protocole (`test-voice-turn-protocol.cjs`).

## Technique L5 et L6 — Réglages par flux, avancement

L5 étend les propriétaires R6 (écriture de la config de l'agent) et R21 (lecture des fournisseurs) ; L6 corrige la projection des étapes. Aucun nouveau store.

### L5 — Lecture

- `GET /v1/providers` (R21) : la projection `projectModelRoles` (`providers.ts`) passe aux 11 flux. Identifiants : `brain`, `web_search`, `conversation_summary`, `memory_search`, `realtime_voice`, `spoken_voice`, `dictation`, `voice_memos`, `immune_system`, `engineering_learning`, `whatsapp`.
- Par flux : modèle, secours, réflexion, vitesse prioritaire, fournisseur et profil (sans identifiant de compte privé, comme le test actuel l'exige), `source` (`gateway_config` | `code_constant` | `model_policy` | `device`), `editable` et sa raison, `inheritsFrom`.

### L5 — Écriture

- `POST /v1/agent/config` (R6, `agentConfig.ts`, aujourd'hui limité à `main`) accepte une cible fermée :
  - `brain` → `agents.entries.main` (modèle, secours, `thinkingDefault`, `fastModeDefault`) ;
  - `conversation_summary` → `agents.defaults.compaction.model` ;
  - `whatsapp` → les 4 entrées `contacts*`, et un profil de flux pour les sessions WhatsApp d'Amine.
- Le profil WhatsApp d'Amine est rangé dans la config du plugin (`plugins.entries.openclaw-plugin-mobile-ui`), écrite par le même `config.patch` avec contrôle de version. Il est appliqué à la création de ses sessions par `sessions.patch` (modèle, `thinkingLevel`), propriétaire existant de `conversationMetadata.ts`.
- **Choix permis** : l'intersection déjà définie par R6 (`modelPolicy.allow`, `models.list` disponible, `models.authStatus` ok) ; aucun profil payant à l'usage.
- **Gardes R6 conservées** : `operationId` et reçu, révision CAS, biométrie par `/v1/confirmations` pour un nouveau fournisseur ou profil (une action par cible, `payloadHash`).
- **Version précédente** gardée dans le reçu pour « Revenir à la version précédente » ; chaque changement inscrit par `context-event.sh` (`completed_action`).
- **App** : un écran `ModelFlowsScreen.kt` remplace `AgentModelScreen.kt`, en réutilisant `AgentConfigContract.kt` et `ProvidersScreen.kt`. Il affiche l'arborescence, les étiquettes (modifiable, lot suivant, lecture seule) et l'origine.
- **Registre** : déclarer la capability d'écriture, ou lister la route en `NO_CAPABILITY` avec sa raison ; ajouter la route modifiée à `companion-acceptance.py`.

### L6 — Avancement sans carte

- `runProgress.ts`, branche des événements Gateway : utiliser `args.title` de l'appel d'outil quand il existe ; ignorer les lectures de contexte du démarrage, ou les résumer en une ligne « Je prépare ta demande » ; fusionner les étapes identiques qui se suivent ; ne jamais émettre de nom d'outil, de fichier ou de commande.
- App (`RunJourneyJson.kt`, interface du parcours) : l'icône suit l'état ; jamais d'icône « en cours » sur une étape terminée.
- Fixture : capture S24 de la course `run_1792920553461_9ffdf172`, réduite aux titres et aux types d'événements, sans commande.

### Tests

- L5 : projection sur capture réelle de `config.get` ; conflit de version ; biométrie exigée ; aucun identifiant privé ; profil WhatsApp appliqué aux nouvelles sessions seulement ; isolement des contacts.
- L6 : `test-run-progress-card.cjs` étendu au cas sans carte ; test JVM de l'icône.

## Plan de livraison et retour arrière

Les lots se suivent dans cet ordre ; L6 peut avancer en parallèle dès que #407 est déployée. Chaque lot ne passe au suivant qu'avec une recette finale verte.

1. **L0 Prérequis**
   - Merge et déploiement de #407 (CI verte prouvée le 25/10), puis activation de #312, jamais en même temps.
   - Lot APK voix v2 ; revue des 12 PR Codex : fusion, reprise ou fermeture motivée de chacune.
   - Porte : recette vocale de #407 verte.
2. **L1 Mesure et recette**
   - Scénarios, mesure de référence, bouton « Ce n'est pas ça » branché.
   - Porte : mesure de référence enregistrée.
   - Retour arrière : APK précédent par `install-from-ci.sh`.
3. **L2 Socle et skills**
   - Porte : aucune relecture au démarrage, recette au moins égale à la référence.
   - Retour arrière : SHA précédent des playbooks par `activate-ui-playbooks.sh`, puis Companion précédent par `companion-deploy.sh`.
4. **L3 Cerveau seul décideur**
   - D'abord derrière l'interrupteur d'hôte ; suppression de l'ancien chemin dans une PR suivante, après recette verte.
   - Porte : scénarios verts sur les trois surfaces.
   - Retour arrière : interrupteur coupé, puis Companion et playbooks précédents.
5. **L4 Voix, budget, mesure**
   - Porte : signe de vie sous 1 s et budget commun vérifiés.
   - Retour arrière : Companion et APK précédents.
6. **L5 Modèles par flux**
   - Porte : modification, biométrie et retour à la version précédente vérifiés en direct.
   - Retour arrière : Companion et APK précédents ; la config se restaure par le reçu.
7. **L6 Avancement sans carte** (parallèle)
   - Porte : capture du 25/10 affichée avec les titres de l'agent.

## Règles de livraison pour Codex

Ces règles viennent des `AGENTS.md` des dépôts et des règles d'Amine ; elles priment sur ce document en cas de conflit.

**Avant de coder**

- `claw_context` au démarrage ; lire `AGENTS.md` de chaque dépôt ; vérifier dépôt, remote, branche et changements concurrents.
- Réutiliser les propriétaires existants : aucun nouveau registre, routeur, store, planificateur, démon, moteur de retry ni pré-routeur parallèle aux capabilities.
- Ne jamais inventer : chaque fait vient d'un reçu Claw, d'un fichier lu ou d'Amine.

**Dans chaque PR**

- Vraies fixtures S24 avec leur provenance ; tests inscrits dans `ci.yml` ou `documentation.yml` dans la même PR.
- Fiche `docs/changes` (`.md` et `.json` v2) ; ADR pour L2, L3 et L4 (nouvel ADR « cerveau seul décideur », révision de `ADR-20261025-voice-brain-delegation.md`).
- Description au gabarit du dépôt (`tools/check_pr_template.py`) : routes, budgets, capabilities, tests, fixtures, retour arrière.
- Nouvelle route dans `companion-acceptance.py` ; capability déclarée ou `NO_CAPABILITY` avec sa raison ; parité MCP vérifiée.

**CI canonique** : `tools/localci.py` hors téléphone, jamais une étape sautée. Environnement constaté le 25/10 :

- clone complet ;
- `/root/.cache/tmp` ;
- `/usr/bin/bwrap` ;
- `/usr/bin/python3` lié directement à l'interpréteur ;
- `LOCALCI_NODE26_BIN` vers Node 26.11.1.

**Déploiement**

- Companion seulement par `companion-deploy.sh <sha>` ; playbooks par `activate-ui-playbooks.sh <sha>`.
- APK construit hors téléphone par `build-apk-offphone.sh`, installé par `install-from-ci.sh --local-build`. Jamais de Gradle ni de CI sur le téléphone.
- Un seul job lourd à la fois sur le S24.

**Lignes rouges**

- Aucune facturation API, aucun achat de crédits.
- Aucun secret, jeton, cookie, `.env`, OTP ni donnée de paiement dans un commit.
- Parcours de paiement inchangé ; biométrie, OTP et 3-D Secure restent humains.

**Exécution et preuves**

- `action_key` stable ; `claw_status` avant tout nouvel essai ; jamais de rejeu d'un effet incertain.
- Ne jamais annoncer « committé », « mergé » ou « déployé » sans SHA, branche, remote et reçu.
- Distinguer les étapes : modification, tests, commit, publication, activation, recette, nettoyage, clôture. Un commit ou une PR ne vaut pas déploiement.
- Inscrire décisions et clôtures dans la mémoire S24, sans transcript.

## Décisions d'Amine sur les points ouverts (25/10, 12:45)

Les sept points sont tranchés ; Codex avance sans autre validation.

| # | Point | Décision |
| --- | --- | --- |
| Q1 | WhatsApp d'Amine par le cerveau | Oui ; remplace le choix du 12/10 « même pour moi il ne faut pas passer par le modèle » |
| Q2 | Seuils | 100 % des scénarios de recette ; signe de vie sous 1 s ; question simple sous 6 s en médiane |
| Q3 | Écritures réelles en recette | Seulement vers Amine : un WhatsApp à son propre numéro, un rendez-vous de test créé puis supprimé ; jamais de paiement ni de tiers |
| Q4 | 12 PR Codex ouvertes | Codex décide (fusion, reprise ou fermeture motivée) et le signale, sans validation |
| Q5 | Budget et attente WhatsApp | 30 s ; sur WhatsApp, indicateur de frappe seulement, puis un seul message « je reviens vers toi » au-delà de 30 s |
| Q6 | Modèle du cerveau | Sol avec vitesse prioritaire, inchangé ; réévalué après L3 sur mesures |
| Q7 | Bouton « C'est ça » | Abandonné avec le banc d'essai |

**Règle permanente (second rideau)** : Codex tranche tout ce qui est réversible. Il ne sollicite Amine que pour un effet irréversible, financier ou envers un tiers, ou pour une étape humaine (biométrie, OTP, 3-D Secure). Amine intervient après la recette finale, en second rideau.

## Sources

**Faits Samantha** : dépôts sfar-amine/samantha-core et sfar-amine/samantha-ui-playbooks lus le 25/10 ; config et traces du S24 lues par Claw le 25/10 (`openclaw.json`, `trajectory_runtime_events`, environnement du Companion) ; mémoire S24 (événements cités).

**État de l'art**

- [Anthropic — Introducing advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use) : recherche d'outils à la demande, appels d'outils par script, exemples d'appel.
- [Anthropic — Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents) : peu d'outils regroupés, préfixes, réponses courtes et utiles, évaluation.
- [Anthropic — Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) ([résumé lu](https://agentic-ai.readthedocs.io/en/latest/ContextEngineering/anthropic/)) : socle minimal, lecture au moment voulu, compaction.
- [OpenAI — Voice agents](https://developers.openai.com/api/docs/guides/voice-agents) : voix en duplex avec délégation au serveur, mesure de l'attente utile.
- [Atlan — What are Agent Skills](https://atlan.com/know/ai-agent/ai-agent-skills/what-are-agent-skills/) : standard ouvert du 18/12/2025, divulgation progressive.
