# C17 — autorité native et raccord des propriétaires

Le canal privé existant admet seulement les profils exacts contacts-pulse et
contacts-projet-pulse. Le propriétaire Contacts relit allowlist, owner=false,
metadata R17 bornée, scope standard, rooms exactes, binding unique et profil
fermé avant les consignes. Custom, contactMemory et restrictions inconnues sont
refusés ; aucune ACL n'est changée.

AGENTS/USER complets viennent du propriétaire réel Pulse ou Projet selon le
profil admis. Le lecteur ne provisionne rien et ne lit ni snapshot, INDEX,
notes, sessions, mémoire ni GLOBAL. Le chargeur compile les octets réguliers
bornés du propriétaire Projet avec leur digest, sans symlink ni cache Python.
Les consignes précisent le rôle de l'interprète en amont du répondant de repli.

Le helper construit la preuve C17 opaque du PB apparié en processus, puis passe
le contexte natif au backend et installe le port privé C18. Ce port refait
l'autorité courante et lie le goal complet à sa révision T1. Aucun callback ne
provient d'env ou de JSON. Les anciennes fixtures C16/C18 conservent leurs
mocks explicitement séparés du nouveau test IPC réel.

Validation : PB 112 tests purs verts après durcissement, plus vrai IPC 1/1
(transport et propriétaires réels, fournisseur/résultat MOCK_ONLY). Les 95 tests
core ciblés ont 91 réussites et 4 erreurs EAGAIN dans des enfants QA existants ;
leur log est conservé, ce n'est pas une réussite de suite complète. Le nouveau
test est inscrit dans le workflow PB et consomme le checkout core frère.
AST et diff-check vérifiés. TS/Node, CI complète du couple exact et LIVE restent
à qualifier. Aucun compte, fournisseur réel, S24, effet métier ou opt-in touché.

L'audience S24 observée est custom/restreinte et reste refusée. Les captures
historiques attestent le format des propriétaires, pas l'admission de ce code
ni les nouvelles consignes à déployer. Activation et qualification appartiennent
à la livraison root après toutes les vérifications. Retour arrière : revert
apparié des sources via les propriétaires existants ; aucun effet à rejouer.

Reprise dans le nouveau Cloud : les 95 tests core passent (10 lecteurs, 38 QA,
47 allowlist), sans EAGAIN. Pipe QA privé 4/4, build TypeScript et 34/34 contrôles
hôte natif sous Node20 passent aussi. Les 79 tests PB C17/C18/C16/A1/A2 incluent
le vrai IPC privé sur ce core. La CI canonique numérotée et la recette LIVE
restent ouvertes ; ce relevé ne qualifie aucun compte, ACL ou activation.
