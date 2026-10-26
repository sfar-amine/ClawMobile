# L5 — modèles par flux, propriétaires et preuve

Source préparée sous la porte L3. Aucun changement S24, activation, recette réelle ou clôture n’est attesté par ce document.

## Propriétaires

R21 `providers.ts` projette exactement les onze flux de la spécification. R6 `agentConfig.ts` conserve la route `GET/POST /v1/agent/config` ; une cible `flow` fermée distingue cerveau, résumé et WhatsApp. Les autres flux restent en lecture. `modelOwner.ts` lit une fois les propriétaires Gateway config/catalogue/auth et la politique canonique des playbooks épinglés ; il ne crée ni registre ni store. Les constantes des propriétaires web/mémos/voix sont importées ; la recherche mémoire sans modèle explicite conserve `model:null`.

Le cache ne conserve pas de credential et publie seulement les handles `acct-…`. La politique canonique et l’état d’authentification doivent tous deux attester un abonnement inclus ou le couple exact modèle/profil gratuit. `available:true`, un jeton Copilot ou une clé Google saine ne suffisent pas. Dans la capture actuelle, Copilot est configuré mais son slot de gratuité est désactivé : il est visible comme valeur actuelle, absent des nouveaux choix. Un retour à un ancien état dont le coût n’est plus attesté est refusé ; une première modification depuis cet état est également refusée avant réservation, confirmation, préservation ou config.patch. Aucune qualification n’est créée automatiquement.

## Mutation et continuité

La requête est liée à la cible, à la révision et au contenu exact par SHA-256, avec `operationId` stable. Un nouveau fournisseur **ou compte**, même en modèle principal, exige la confirmation biométrique existante, scope `agent.config.expand_fallbacks`, référence `flow:<id>`, hash exact. Le paiement n’est pas modifié.

Les seuls champs écrits sont modèle/effort/vitesse de main, le modèle de compaction, ou les trois champs des quatre agents contacts plus `whatsappModelFlow` dans le schéma fermé du plugin. Identité, workspace, outils, mémoire, permissions et canaux ne sont pas copiés. Le résumé n’invente aucun champ effort/vitesse/secours dans le propriétaire natif model-only.

Le run R6 est réservé et checkpointé **avant** la préservation des sessions. La préservation doit être attestée par le propriétaire natif de session avant `config.patch`. La source inclut le propriétaire patchSessionEntry SQLite, les consommateurs avant modèle/compaction et le patchset de compatibilité épinglé ; le runtime doit attester ce contrat apparié avant tout changement. Il n’existe aucun succès no-op. Une activité préparée ou un effet indéterminé reste visible dans ce même ledger pour empêcher les premières sélections non épinglées. Aucun verrou, worker ou moteur de retry supplémentaire n’est introduit.

Le reçu version2 conserve seulement les valeurs/présences publiques des champs possédés, et l’empreinte de l’état appliqué. « Version précédente » vérifie le reçu, sa cible, la révision et l’empreinte courante avant de restaurer exactement ces champs. Un conteneur nouvellement créé ne peut être supprimé au retour arrière s’il contient désormais une clé étrangère. Aucun effet incertain n’est rejoué. Une preuve mémoire `completed_action` est produite par le writer existant ; son absence demeure `continuity:pending`.

## Fixtures et tests

Les captures nettoyées `fixtures/refonte-model-flows/s24-*-20261025.json` viennent des lectures autorisées S24 avant code : propriétaire `readModelOwnerFresh`, configuration/profils strictement projetés, politique canonique épinglée. Companion observé `d87bd2494f079a4dc6753b619550d4f76ab600db`, playbooks `698322f70d454151b802e3c5850db82f4a38d046`, OpenClaw2026.9.6. Sources natives privées conservées dans `~/.openclaw/autonomous-engineering/acceptance/refonte-l5-20261025/` ; aucun auth-store exporté. La capture contient cinq modèles disponibles, sept agents et les quatre espaces Contacts. Les valeurs privées des profils ne sont jamais exportées.

`test-model-roles.cjs` utilise directement ces captures ; `test-model-flows.cjs` utilise leur structure avec identités privées et effets locaux **explicitement rédigés**. Ses succès ne sont pas une recette native. Il vérifie coût inclus, profil opaque, biométrie sur nouveau primaire, CAS, refus de préservation non qualifiée, idempotence, restauration exacte, isolement Contacts, préservation du résumé et absence de rejeu après perte du readback. Tests inscrits dans la CI existante. Les tests de compat/pins SDK et SQLite interprocessus sont joints et ciblés verts ; la CI canonique et la recette réelle restent requises avant admission finale.

## Mesures et limites d’attribution

R19 fournit des quotas par fournisseur, sans attribution de tour à un flux. L4 distingue surfaces app/voix/WhatsApp et routes outil/question/réponse/réflexe ; ces routes ne prouvent pas web/résumé/mémoire. La latence WhatsApp n’est projetable qu’avec la corrélation native UUID exacte. Le taux « Ce n’est pas ça » reste inconnu lorsque le feedback n’est pas corrélé au même run. Une période retenue n’est pas sept jours complets d’instrumentation. Aucune médiane ou valeur zéro n’est fabriquée.

## Livraison

Budgets lectures trois variantes R6 :9s, déclarées dans `companion-acceptance.py`. Les mutations conservent le refus sans en-tête propriétaire et ne sont pas exécutées par la recette automatique. Le volume réel451sessions est un prérequis de qualification du propriétaire de préservation ; ne pas serialiser451processus Gateway sous un budget45s.

La route R6 est déjà `NO_CAPABILITY` GET/POST dans `capabilities/registry.json` des playbooks épinglés698322f7 : écran propriétaire, aucune admission agent/voix. Aucun outil MCP n’est ajouté ; schémas et les six primitives Claw restent inchangés. App et Core doivent être appariés ; ordre de livraison L3 conservé, admission v2 par preuve R6 durable et non par flag d’environnement ; l’ancien writev1 refuse dès qu’une provenance modelFlowSelection existe. Canonical CI hors téléphone sur les heads publiés, déploiement par propriétaires existants, puis recette S24 et mémoire de clôture restent obligatoires. Le reçu SDK/runtime-sync/rollback est requis avant de promettre « nouvelles sessions seulement ».
