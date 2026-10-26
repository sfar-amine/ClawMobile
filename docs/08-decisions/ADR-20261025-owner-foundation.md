# ADR L2 — socle propriétaire partagé avant la bascule du décideur

Statut : proposé ; activation et recette non effectuées.

## Contexte et décision

Les décisions S24 du25/10 (3fcf038f,0a436deb,3852c560) imposent un socle injecté/cacheable avant L3. Les fichiers canoniques, Memory Core et les skills existants restent propriétaires. Le générateur des playbooks dérive une projection ; les consommateurs n'en font pas un registre parallèle.

Le hook SDK `before_prompt_build.prependSystemContext` fournit le préfixe cacheable aux sessions main natives. La capture SDK2026.9.6 confirme ce champ et le cache bootstrap64snapshots rafraîchi quand les fichiers changent. L'app et le cerveau voix utilisent le même générateur via `compactOwnerAgentContext` dans leur `extraSystemPrompt` existant ; le hook ne réinjecte pas une seconde copie dans les sessions Companion. Les agents Contacts et les workspaces différents ne lisent jamais ce socle.

Les règles stables précèdent la mémoire. Les contraintes et fils ouverts du matérialisateur existant restent complets ; trois activités récentes sourcées sont exposées, le reste se retrouve via Memory Core. Les corps de skills ne sont lus que pour une tâche pertinente. Le contexte d'une session déjà démarrée se rafraîchit par la révision et les deltas existants, sans acquittement implicite du lecteur.

## Frontières et livraison

Le drapeau d'hôte `SAMANTHA_CONTEXT_FOUNDATION=1` permet la recette appariée avant L3. Aucun champ de client ne confère l'injection ou une autorité propriétaire. Sans socle valide, le producteur refuse plutôt que tronquer une règle ; les instructions décrivent la récupération canonique. Sans drapeau, le comportement précédent reste disponible jusqu'à recette et nettoyage.

Aucun nouveau store, routeur, registre, planificateur, retry ou démon. Les paiements, confirmations et étapes humaines sont conservés. Les propriétaires d'activation existants installent les skills et blocs gérés avec sauvegardes/contrôle de concurrence.

La réponse complète `claw_context` et le socle sont testés sous6000jetons estimés UTF8/4. Cette estimation ne remplace pas les usages fournisseur. La clôture exige une recette réelle sur les3surfaces, traces sans relectures de démarrage et mesure de latence avant/après. Retour arrière : drapeau désactivé, pins précédents via les propriétaires existants.

La projection place l’empreinte stable et les descriptions de skills avant les règles stables, puis la mémoire. L’empreinte globale et la révision mémoire restent en fin de corps : une révision ne doit pas invalider le préfixe identique des règles chez le fournisseur. Le test compare deux révisions différentes et vérifie à la fois le préfixe commun et le changement réel du contexte. Le gain de cache fournisseur demeure à mesurer en recette ; la disposition seule ne prouve pas un cache hit.

La substitution des blocs de démarrage conserve le contexte propre à la surface voix : VOICE_TURN et le VOICE_CONTEXT optionnel déjà fourni par le lecteur canonique restent après le même socle commun quand voiceDelegation est attesté. Les autres surfaces ne reçoivent pas ce fichier de mémoire voix. Il ne s’agit pas d’une nouvelle source ni d’un nouveau mécanisme de contexte.

## Projection MCP sans double encodage

L’adaptateur livre le contenu stable/mémoire en texte unique dans la lecture `context/FOUNDATION` et laisse l’index des skills ainsi que les empreintes/révision dans la métadonnée existante. Le hash de la lecture couvre exactement les octets livrés. Les empreintes détaillées de chaque fichier, déjà liées au fingerprint agrégé du producteur, ne sont pas répétées. Le même corps reste injecté côté SDK et Companion ; aucun droit ni argument client nouveau. Le propriétaire refuse un corps absent ou une enveloppe dépassant24000octets avec une réserve256octets pour la métadonnée d’accès. La recette devra vérifier le contexte réel et la parité ; une projection calculée en mémoire n’est pas un PASS natif.
