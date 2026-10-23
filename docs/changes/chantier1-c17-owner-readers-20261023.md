# C17 — jalon lecteurs propriétaires, sans activation

Contacts.metadata lit les deux lignes de l'en-tête R17 puis le marqueur de fin
de longueur fixe, avec un
descripteur non bufferisé : aucun octet de la note après le marqueur de fin
n'est lu, même si la note suit immédiatement ce marqueur sans saut de ligne.
Un marqueur incomplet ou différent est refusé. Un fichier non géré s'arrête dès
la première ligne. Le descripteur
O_NOFOLLOW/O_NONBLOCK est contrôlé par fstat (fichier régulier et UID courant)
avant toute lecture, pour refuser symlink/FIFO/périphérique sans blocage.

Le propriétaire pulse-room expose un lecteur pur des corps AGENTS/USER complets
de son workspace exact. Il refuse symlink, fichier non régulier, UID différent,
capacité dépassée, corps différent ou variation du fichier pendant la lecture.
Il n'appelle ni provision, ni workspace, ni rules et n'ouvre aucun autre fichier.

Validation ciblée : 10 nouveaux tests ; 38 tests QA room access et 47 tests
WhatsApp allowlist existants, tous verts. Le nouveau test figure dans ci.yml.
Fixtures nouvelles entièrement synthétiques, construites au format des
propriétaires existants ; elles ne prouvent aucun ACL/profil S24 actuel.
Les corps historiques Pulse observés par root le 23/10 sont égaux aux constantes
canoniques (AGENTS 1340 octets, USER 93 octets) ; aucun contenu privé n'est ajouté.

Ce jalon ne raccorde PAS C17 au backend, DATA01 ou C18. Il ne crée aucune preuve
d'accès native, ne modifie ni TS ni l'allowlist ni les consignes et n'active aucun
flag. Le port _NATIVE_FAST_READ_SCOPE_OWNER demeure non configuré. L'audience
courante contacts-projet-pulse a une restriction personnalisée et de la mémoire
contact : elle n'est pas qualifiée par ce jalon. Aucun accès GLOBAL, modèle,
S24, effet métier ou déploiement n'a été effectué par ce lot.

La CI canonique du head exact reste requise ; l'environnement Cloud ne permet
pas la concurrence nécessaire au moment de cette sauvegarde. Aucun PASS CI
complète ou LIVE n'est revendiqué. Retour arrière : revert source, sans effet
ni rejeu métier. Aucun store, route, registre ou exécuteur ajouté.
