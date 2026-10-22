# C16 — entrée native de la phase Pulse confirmée

Le pilote hôte `SAMANTHA_NATIVE_PULSE_HANDOFF=1`, absent par défaut, ne concerne que le hook authentifié `contacts-pulse`. Le contact actif, sa pièce, sa session et son expiration sont relus auprès du propriétaire existant `allowlistRead('get')`, à l'admission et avant dispatch. Les groupes, la pièce mixte, les identités `untracked:` et les objets sérialisés ne mintent pas l'admission opaque.

La voie générique app/WhatsApp et les chemins voix/paiement ne sont pas activés par ce flag. Aucune sélection de domaine par mots n'est ajoutée. Dans le pilote admis, DATA inconnu, IR invalide, intention non reconnue, ambiguïté et préparation native indisponible restent `handled:true` et `modelAllowed:false`. La demande n'est jamais confiée après cet échec à un agent libre, un Gateway fallback ou un résolveur lexical ; la compatibilité legacy n'existe qu'en dehors du pilote.

Le texte exact et les métadonnées natives passent sur le stream enfant privé borné à 16 Kio/2 s, contrôlé UID/pair. Le helper exige le même acteur, fil, événement et propriétaire PB épinglé. Les références JSON ne sont aucune autorité de confirmation ; le grant Pulse est recréé dans le processus Python depuis le DialogueStore canonique courant.

Le parent réutilise les propriétaires T1/handoff, Continuum et RemoteBridge : prépare/arme l'Attempt, exige le fence actuel, revendique durablement received/running, puis appelle sa closure privée native. Le callback MCP readonly reste limité à la lecture. Le helper natif relit le consentement exact puis appelle le Graph et le CLI canonique ; son reçu fermé ne contient ni formulaire, ni corps POST, ni plan complet. Seul le résultat métier lié et vérifié permet settle, puis l'observation T2 sans deuxième commande.

Un Attempt armé, même sans reçu après crash, est observe-only. Un doublon retrouve le reçu, un changement sous la même identité donne conflit ; timeout ou résultat indéterminé ne donnent jamais lieu à une nouvelle soumission automatique. Le pilote ne qualifie qu'une opération `phase_status` ; les autres mutations/durable et les confirmations MCP client_reported restent fermées.

**Production native NOT_IMPLEMENTED** : la préparation C14 ferme avant login avec `native_contract_unqualified` jusqu'à qualification C15 des captures de projet. Aucun booléen JSON, label de fixture ou flag de pilote ne la lève. La paire est MOCK_ONLY : vrais hook/IPC/Store/Continuum/Bridge/Graph, sorties fournisseur et processus HTTP simulés. DATA fermé exerce le vrai garde avec zéro tentative réseau. Elle ne prouve ni compte/modèle, ni droit natif, ni latence de production, ni déploiement.

Les limites des propriétaires sont conservées : commande 32 Kio, reçu métier lu 512 Kio au plus, événement privé 30 s, acquittement Bridge 12 s puis statut. Les coûts réels des lectures de droits et du modèle/Pulse restent à mesurer ; aucune fixture n'atteste un budget réel inférieur à 15 s. Aucun nouvel endpoint HTTP, store, registre, routeur, exécuteur, ordonnanceur ou démon.

La CI versionne la paire avec le head PB immuable déclaré dans le workflow ; absence/mauvais SHA refusés. Le reçu exact complet de CI locale et la qualification native sont des portes séparées. Retour arrière : enlever le pilote et utiliser les propriétaires de release en observant les reçus existants, sans replay d'effet.
