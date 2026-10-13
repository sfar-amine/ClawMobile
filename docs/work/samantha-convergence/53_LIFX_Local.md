# 53 — LIFX local : commande déterministe et écran Samantha
Date : 13/10/2026. État : sources en branches isolées ; non fusionnées, non déployées.

## Besoin validé
Amine demande le contrôle de sa lampe depuis l’écran, la voix et le texte, exclusivement en local. La maquette Blanc/Couleur est validée avec l’icône audio-lines violette existante. Une intention ambiguë doit être clarifiée avant toute mutation. Le « Go » autorise l’implémentation de ce périmètre.

## Implémentation
- Core runtime : adaptateur UDP LIFX, routes GET /v1/lighting/discover, GET /v1/lighting/{device_id}/state, GET /v1/lighting/{device_id}/diagnostics et POST /v1/lighting/{device_id}/state.
- Playbooks : neuf capabilities samantha.app.lighting.* (discover, read, diagnostics, on, off, brightness, white, color, set). Binding des paramètres uniquement après sélection par le Graph existant ; clarification existante, aucun routeur parallèle.
- Android : écran Lumière dans les services de Capacités. Même capability-bridge que voix/texte ; marche/arrêt, luminosité, blanc 1500–9000 K, raccourcis 2700/4000/6500 K, couleurs et sélecteur teinte/saturation, lecture de connexion, icône voix existante.
- Paramètres absents : question ciblée. Réponse de clarification convertie en commande structurée canonique, sans retenir les alternatives contradictoires de la demande initiale.
- Les changements préservent l’alimentation lorsqu’elle n’est pas explicitement demandée. 0 % de luminosité reste distinct de power=off.
- Les commandes sont immédiates ; pas de programmation ni de replay après reconnexion. Les demandes relatives sans valeur absolue sont clarifiées.
- Couleurs nommées initiales : rouge 0°, orange 30°, jaune 60°, vert 120°, bleu 240°, violet 270°, rose 330°, saturation 100 %. Pas de luminosité implicite. La palette écran comprend aussi cyan 180°.

## Frontières
App/texte/voix → Graph/capability → Companion owner → UDP LAN → lecture de vérification.
Le protocole local est sans token LIFX et sans repli cloud. Cette propriété ne rend pas le moteur vocal hors ligne et ne désactive pas le cloud propre à la lampe.
Le connecteur est qualifié pour le produit réel A19 vendor 1 / product 27 / firmware 2.x >=2.80. Aucun support d’autres modèles affirmé.
Les mutations utilisent nativeOperation et le ledger existant ; même operationId avec paramètres différents refusé. Aucun store, daemon, scheduler ou retry owner ajouté.
Un ACK ne suffit pas à déclarer le succès. Lecture séparée après transition ; resultat unconfirmed en cas de perte de vérification. Aucun retry automatique d’une mutation incertaine.

## Android / Termux
getifaddrs via Node ne fournit que loopback sur ce S24. L’adaptateur réutilise adb_shell pour lire ip route, avec délai borné ; aucun changement de Wi-Fi/4G. La découverte reste liée à wlan0. Lecture locale réelle : 878 ms (état + diagnostic), sans mutation.

## Preuves
Fixture réelle : lifx-a19-s24-20261013.json, S24 via RDC, Get messages seulement.
État observé le 13/10 à 17:39:58Z : Lif8x allumée, luminosité 49.4209 %, blanc 3005 K, firmware 2.90, RSSI −58 dBm.
Core : compilation TypeScript et tests paquet/readback, conservation des composantes, perte d’ACK, absence de réponse, expiration, double soumission, conflit, refus owner/browser.
Playbooks : suite ciblée de 36 tests verte (LIFX, registre, clarification, entrypoint, usage).
Android : tests LightingReplyTest ajoutés avec fixture réelle ; build et tests JVM à exécuter dans Actions. Aucun Gradle sur le S24.
Les tests d’écriture sont simulés ; aucune commande réelle d’allumage/extinction envoyée dans ce lot.

## Livraison et dépendances
1. Revue des PR runtime et playbooks ; activation coordonnée selon le process existant.
2. Build CI de la branche Android puis installation par install-from-ci.sh.
3. Recette live : on/off, blanc/couleur/luminosité, quitté-app, voix/texte, coupure réseau, restoration de l’état initial.
La disponibilité d’un Companion loopback sain et d’ADB fonctionnel est une dépendance explicite. La recette de mutation et la recette visuelle ne sont pas acquises.

## MCP owner
claw_resolve et claw_execute exposent les nouvelles capabilities via le Graph existant. Pas d’outil LIFX autonome ajouté. Les autres primitives restent inchangées ; parité de sélection chatgpt/owner, external_mcp/owner, Samantha Android et claw_live vérifiée dans les tests. La parité runtime attend activation du registre et du core.
Les nouveaux droits restent owner-only ; aucun accès de contact WhatsApp n’est élargi.

## Retour arrière
Revert des commits LIFX et retour au registre/runtime antérieurs par les scripts de déploiement existants. Aucune configuration de lampe, firmware, Wi-Fi, libellé ou pièce modifiée.
