# C18 — lectures natives FAST Pulse

C18 raccorde le handoff FAST déjà admis aux propriétaires existants : événement privé `contacts-pulse` → T1 du DialogueStore → relecture canonique du goal → précondition hôte courante → Coordinator → Graph `read_only=True` → CLI Pulse existant → T2. Le tag transport `native_fast_ready` choisit une phase et ne confère aucun droit. La seconde phase recharge le même goal et les mêmes références avant l’appel métier.

Le libellé Graph `caller=owner` demeure un contrat de cette surface ; il ne transforme pas le contact natif en Amine, ne donne pas GLOBAL et n'autorise aucun autre contact ou fil. Les contrôles natifs de contact/pièce restent relus à chaque processus privé. La précondition C18 est un objet privé éphémère lié à l’événement natif, contact, conversation, request, goal, révision, décision entière et échéance de 30 secondes au maximum. Son contrôle hôte doit revalider le véritable service autorisé ; un retour booléen/JSON est refusé. Aucun grant ou nouvelle persistance n'est ajouté.

## Activation et limites

**Production fermée : C17 n’a pas encore fourni sa preuve réelle d’accès au workspace professionnel et au fil.** Le port `_NATIVE_FAST_READ_SCOPE_OWNER` reste `None` ; aucun argument, environnement ou JSON client ne l'installe. Le futur propriétaire C17 devra fournir sa preuve native scellée après revalidation ACL/binding/workspace/event/fil, ainsi que la qualification complète du prompt avant l’interpréteur. C18 ne lit ni GLOBAL, ni archives, ni configuration privée, ne crée pas de preuve C17 et n’active aucun modèle. Les manifestes WIP C17 ne sont pas inclus.

La qualification ici est **MOCK_ONLY** : sortie sémantique enregistrée, contrôle scoped simulé étiqueté et dernier port de lecture métier simulé. Les vrais IPC, codec d’identité native, Store, Coordinator et gardes Graph sont exercés. Aucun fournisseur, téléphone, réseau métier ou paiement. Les contrats natifs R17/C16 existants sont réutilisés ; aucune nouvelle capture n’est présentée comme preuve actuelle.

Les mutations, confirmations et handoffs DURABLE ne passent jamais par ce raccord. Le corridor C16 reste propriétaire des phases confirmées. Le garde Graph en lecture seule reste obligatoire. Les lectures peuvent employer les POST d’authentification/recherche déjà nécessaires au CLI ; aucune nouvelle mutation n’est autorisée. Après T2, le replay rend le résultat sans lecture ni interprétation. En cas de crash avant T2, les règles existantes de reprise FAST s'appliquent aux lectures pures ; C18 ne promet pas une lecture exactement une fois après un crash.

## Causes et retour arrière

Absence de preuve : `native_pulse_read_scope_unqualified`. Événement/TTL/révision modifiés : `native_pulse_read_scope_stale`. Goal/handoff modifié : `native_pulse_read_handoff_changed`. Commande non FAST/lecture : `native_pulse_read_only_policy`. Le résultat est traité avec `modelAllowed=false` et ne reprend pas l’agent général. Les exceptions privées sont masquées.

Désactiver le pilote natif remet les entrées sur leur parcours hérité existant ; les reçus du Store restent conservés. Aucun changement du paiement, de la voix cloud ou d'OAuth. CI complète sur head exact et recette native C17 restent distinctes de ces tests ciblés.
