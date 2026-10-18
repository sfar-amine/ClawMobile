# QA64 Q12 — protéger une campagne contre un déploiement

Le déploiement reprend le verrou canonique `~/.openclaw/deploys/companion-deploy.lock` en exclusif. Une campagne QA peut le tenir en partagé de son admission à sa fin de nettoyage (propriétaire `qa_testing`, playbooks #201). Il n'y a ni deuxième verrou ni lecture concurrente du fichier de campagne côté déploiement.

L'acquisition attend au plus 10 secondes par défaut, réglables par `COMPANION_DEPLOY_LOCK_WAIT_S` entre 0 et 600 secondes entières. Tant que le verrou est occupé, aucun fetch, compilation, arrêt de processus ou redémarrage ne commence. À expiration, le script termine avec le code 3 et la cause `deploy_lock_busy`, sans programmer de relance. Le message ne prétend pas distinguer une campagne d'un autre déploiement. Une erreur d'ouverture ou de `flock` refuse aussi le déploiement. Le reçu canonique reste écrit après acquisition exclusive ; aucun reçu concurrent n'est ajouté pendant qu'un autre déploiement écrit le sien.

## Source et tests

Capture en lecture seule du S24 du 18/10/2026, runtime `edb6238449bf8754e94fa2b91de78edd52ccbc19` : chemin du verrou, mode 0600, source de déploiement et prise en charge de `flock -s`/`-n`. Seule cette liste blanche est versionnée dans `openclaw-plugin-mobile-ui/fixtures/qa/deployment-lock-s24-20261018.json`. Aucun verrou réel n'a été acquis pendant la capture, aucune campagne ni action UI exécutée.

`installer/termux-lite/test-qa-deploy-protection.py`, inscrit dans `.github/workflows/ci.yml`, teste de vrais verrous locaux dans des répertoires temporaires : campagne partagée, déploiement exclusif, deux campagnes, libération pendant l'attente, expiration sans relance, budgets invalides et erreur de flock. Les commandes à effets sont des pièges locaux ; le seul chemin admis s'arrête au préflight existant batterie/mémoire. Les dix tests ajoutés tournent en moins de quatre secondes, sans réseau ni téléphone. Les tests existants de préflight et de racine sont conservés.

Aucune nouvelle route ni capability : ce point étend le propriétaire de déploiement existant, réservé à Claude. Pas de changement du paiement, de la voix ni de l'assainissement de l'environnement hérité (décision D).


## Redémarrages Companion et Gateway

Le propriétaire `runtime_mode.deployment_guard` fournit aussi un bail éphémère pour les opérations start/stop/restart du Gateway et la réparation HTTP du Companion. Il ne lance aucune commande et ne crée aucun état : il confirme l’acquisition du verrou canonique et reste lié au pipe de son appelant. Le parent conserve la même description de fichier ouverte jusqu’à la fin de son opération ; même un helper tué ne relâche pas EX pendant la mutation. Aucun descripteur de ce verrou ne passe au démon réparé.

Le contrôle final HTTP et les effets restent dans la même section exclusive. Les sondes de mode et d’inactivité essaient maintenant EX, ce qui détecte aussi les campagnes SH. Les refus exposent une cause fermée (verrou occupé, arrêt d’urgence ou protection indisponible), sans détails privés. Les réparations annexes SSH/Slack/ADB ne sont pas couvertes par ce nouveau bail ; aucune protection universelle n’est annoncée.

La localisation Node importe `runtimeFile` du propriétaire unique F1 (`src/runtimeRoot.ts`, core #320). Il résout la release courante attestée par Tier0 et ignore l'ancienne racine héritée ; un propriétaire indisponible refuse toute mutation. #320 doit être fusionnée avant #338 ; la présente branche intègre son head par merge normal, sans copier son propriétaire ni modifier l’environnement hérité (décision D).

Claude a confirmé en lecture seule le 18/10 à 12:53Z l’export effectif `CLAW_RUNTIME_ROOT=/data/data/com.termux/files/home/ClawMobile/installer/termux-lite`, ainsi que le helper présent (4 899 octets, mode 0700, SHA256 `110e5507…`). Le runtime installé est `145339bb` ; `edb62384` en est un ancêtre et les cinq sources qualifiées sont inchangées. La fixture liste uniquement ce champ autorisé et ses preuves : [réponse Claude #338](https://github.com/sfar-amine/samantha-core/pull/338#issuecomment-6250165935). Aucune lecture globale ni modification d’environnement n’a eu lieu.

Les trois appelants historiques installés de `POST /v1/runtime/restart` sont la récupération WhatsApp et la garde mémoire du health-manager, ainsi que `runtime-sync.sh`. Le bail est acquis à leur point commun `runSerializedRuntimeOperation`, couvrant l’ensemble du stop/start pour chacun. Aucune route `/runtime/restart/proof` n’existe ou n’est ajoutée. Ce contrat est confirmé par la [réponse Claude #201](https://github.com/sfar-amine/samantha-ui-playbooks/pull/201#issuecomment-6250168400) et destiné au document 64 Q12 dans la PR playbooks #201.

Les cinq propriétaires installés ont été confirmés par leur empreinte SHA256 sur le S24, identique au checkout de base ; leur liste blanche est versionnée dans `restart-source-s24-20261018.json`. Il n’existe pas de route `/runtime/restart/proof` dans ces sources. Les nouveaux tests de bail exercent les vrais verrous Linux, le refus SH, la conservation EX après arrêt du helper, la libération sur EOF et l’absence d’héritage par un démon ; ils restent entièrement locaux et sous le budget QA de 60 secondes avec les tests de déploiement.

## Correction de la relecture bloquante du 18 octobre

La [relecture Claude #338](https://github.com/sfar-amine/samantha-core/pull/338#issuecomment-6254432983)
a identifié le redémarrage pendant un déploiement qui tient déjà EX sur FD9. Un
appel HTTP ne peut hériter de cette description : il doit donc rester refusé.
`runtime-sync.sh` appelle désormais le même propriétaire Node stop/start comme
CLI privé fermé `--deploy-restart`, dans l'arbre de processus du déploiement.
Le helper Python du checkout est explicite à cette frontière de déploiement :
la précédente release Tier0 n'est promue qu'après le redémarrage et peut ignorer
ce nouveau contrat. Cela n'ajoute aucun repli au résolveur runtime F1 ni option HTTP.
Le helper vérifie le même inode et une EX préexistante : une sonde SH indépendante
doit être refusée, puis EX doit réussir sur la description héritée elle-même.
Un descripteur simplement ouvert, partagé, étranger ou absent ne constitue pas
une exemption. La fin du helper et du CLI ne déverrouille pas le parent ; le
démon Gateway ne reçoit aucun descripteur du bail.

Un verrou absent est créé au même chemin, en0600, par les propriétaires existants.
Node et Python refusent les parents non sûrs, liens, fichiers non réguliers,
liens physiques multiples et changements d'inode. La réparation health-manager
utilise cette création propriétaire avant d'ouvrir son descripteur, puis revalide
avec le helper ; aucun verrou existant n'est supprimé ou remplacé.

Les tests utilisent de vrais flock, processus et un Gateway TCP synthétique :
15 tests du helper, 16 de synchronisation (dont absence de POST pendant EX),
4 du health-manager, 9 contrats Node et le vrai CLI de redémarrage. La fixture de
budget web du test runtime-sync est alignée sur les30000ms du runtime intégré ;
aucun budget de production n'est modifié par cette correction. Les tests figurent
dans la CI, sans exécution sur le téléphone.

Le bail SH de campagne reste détenu par `qa_testing.common.campaign_deployment_lease`
dans playbooks. Son suivi de durée et son cleanup sont un changement de ce
propriétaire distinct ; ils ne sont pas remplacés par une réparation qui ignorerait
un SH vivant. La présente correction core ne prétend pas encore borner ce bail.
La CI canonique complète doit être rejouée au head final de cette PR après le
merge normal du correctif F1 final. Les anciens reçus CI ne qualifient pas ce head.

## Recette après fusion et épinglage par Claude

Dans la recette Q12 bornée (3 cas × 15 étapes, 10 minutes, une relance d'environnement au plus), montrer qu'une campagne détenant le verrou partagé empêche le déploiement, puis que sa fin de nettoyage libère l'exclusif. Un appareil verrouillé, occupé ou injoignable donne BLOCKED et sa cause, sans boucle d'essais. Cette PR ne revendique aucune recette physique.

## Retour arrière

Revenir sur ce changement rétablit le refus immédiat du déploiement en cas de verrou occupé. Le chemin, le format des reçus et le propriétaire du verrou ne changent pas. La protection partagée de QA reste compatible avec le refus immédiat antérieur.
