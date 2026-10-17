# Orange Fastpath — un propriétaire réseau, une admission, un reçu final

Suite de la PR core112, intégrant par merge normal le propriétaire Unix/forward existant de core271. Dépendances produit : playbooks56 pour l’entrée canonique et Android267 pour le canal natif. Aucun composant n’est activé par ces commits. Source prête à revue seulement ; aucun gain fournisseur candidat ni recette texte/voix physique n’est revendiqué.

Le propriétaire `device.network_safety` existant prend un seul snapshot de préparation (connectivité, Wi-Fi, réglages, souscriptions), confirme la SIM data Orange605/01 et le réseau unique validé sans VPN/proxy, puis garde cette décision dans son bail existant. Cellulaire Orange principal : lecture directe, sans toggle ni probe DNS/TCP ajouté. Wi-Fi principal avec cellule qualifiée : canal Android lié au handle et à la souscription exacts. Le corridor Wi-Fi-off déjà autorisé reste un choix explicite initial ; aucun repli n’est réamorcé après ouverture de canal incertaine. Inconnu/ambigu/VPN/proxy : refus avec cause. Aucun token fournisseur n’est ajouté au bail ni à un cache.

`consultation-context <lease>` transporte une enveloppe fermée, avec le temps enfant restant, au plus44s après la réserve de restauration16s dans la borne totale60s existante. Les pointeurs d’environnement ne confèrent aucun droit : naissance du garde, commande canonique, UID, ascendance et véritable ligne FLOCK WRITE fdinfo sont exigés. Le FD hérité garde le même verrou ; un verrou POSIX sur ce même fichier sérialise les helpers frères. Aucune délégation aux mutations génériques/paiement.

Le forward Unix est journalisé sous le même bail avant la demande Android. `verify-consultation-channel <forwardLease> --session <appSession>` vérifie propriétaire vivant, tuple nonce, inode/socket/ADB serveur, app status réel, session/lease/socket et sélection native attendue. Une réponse déclarative ou un JSON `SAMANTHA_MAXIT_CHANNEL` seul ne donne aucun accès.

Le garde stoppe le groupe enfant avant tout reçu final, vérifie indépendamment fermeture app et retrait du seul forward possédé, puis certifie le réseau. Les booléens `closed`/`restored` du fils ne font jamais autorité. Un échec de cleanup remplace tout succès/cartes. Le reçu garde les six champs historiques, des routes explicites `cellular_default`, `cellular_bound_wifi_unchanged`, `guarded_fallback` et, pour le canal, son identité forward séparée de `lease_id` consultation. Les métriques de préparation sont hors de cet objet fermé.

Le restaurateur détaché existant récupère aussi un parent SIGKILL : identité du groupe journalisée avant READY, startup pipe EOF avant admission, arrêt du groupe avant reprise du FLOCK. Il recharge le bail avant chaque tentative afin de ne pas ignorer un enfant journalisé juste avant la mort du garde. Un PID remplacé n’autorise aucun signal. Aucun nouveau watchdog, store ou service.

Le constat réel du15/10 (`read-offer.json`) montre pourquoi Wi-Fi « activé » ne suffit pas : le résultat de l’ancien parcours disait succès, mais son observation immédiate voyait encore le cellulaire principal et aucun Wi-Fi connecté. Le nouveau reçu exige connexion effective, réseau principal validé et SIM data attendus ; après notre toggle seulement, reconnexion attendue dans la réserve bornée. Un chemin sans mutation ne réécrit aucun changement externe et refuse de le certifier. Les réglages/proxy et VPN sont également contrôlés. Ce constat n’affirme pas un échec définitif de reconnexion du S24.

## Preuves et limites

Captures S24 nettoyées : `fixtures/s24-2026-10-15/orange/`, préflight core344b2fd / playbookscbeb6e7, fdinfo verrouillé/non verrouillé, souscriptions/PLMN et réseaux, ancienne lecture d’offre. Aucun compte, SSID, IP, bearer, cookie ou numéro conservé. Les chaînes assemblées dans les tests sont explicitement des projections de fragments capturés.

Les cinq suites réseau sont inscrites dans la CI conservée par union : garde78cas, reçus13, processus8, budget6, fastpath/FD/récupération11. Les tests de processus utilisent le vrai garde, le noyau, le bail, le FD et le restaurateur avec ADB factice uniquement. Une preuve conjointe séparée exécute les vrais modules playbooks56 et le helper core ; seuls ADB et la frontière fournisseur sont inertes. Elle couvre canal, direct, refus sélection app erronée et refus environnement canal seul (4/4), sans réseau ni appel fournisseur réel. Le décompte CI complet au SHA distant exact est publié dans la PR après exécution.

La promotion reste NO-GO avant intégration des trois propriétaires, recette contrôlée S24 (réseau réellement sélectionné, restauration effective, app, texte/voix), mesures A/B froid/chaud avec p50/p95 qualifiés et cleanup physique. Les mesures inertes ne sont pas des performances Maxit. La preuve physique du canal Android et ses permissions/API restent à Claude ; aucun nouveau droit téléphone n’est demandé ici.

Retour arrière : ancienne release par Claude et son mécanisme canonique ; garder le propriétaire de récupération des baux ouverts, ne jamais effacer un bail pour masquer une dette de cleanup. Le parcours paiement `with_wifi_off` et sa surveillance sont identiques à la source S24 core344b2fd ; aucune règle de paiement, biométrie ou3DS n’est modifiée.

## Intégration du 17/10 (Claude) — décision d'Amine « 4G et Wi-Fi »

Amine a tranché le 17/10 : les parcours Orange/Maxit sont admis en 4G et en Wi-Fi. Cette décision remplace la règle « 4G gardée » de l'audit « mon solde orange » du 10/10 et le point 5 des décisions ouvertes du fichier 52. `AGENTS.md` (règle 9) est mis à jour. Le reçu atteste le chemin réellement utilisé (`cellular_default`, `cellular_bound_wifi_unchanged`, `guarded_fallback`) ; le Wi-Fi n'ouvre aucun contournement d'authentification.

Garanties paiement prouvées par `installer/termux-lite/test-payment-guard-invariance.py` (inscrit dans `ci.yml`) :
- les fonctions du parcours de recharge (`with_wifi_off`, `_run_without_mutation`, `run_while_wifi_stays_off`, `wifi_toggle_decision`, `restore_state`, restaurateur…) sont identiques octet pour octet à la base runtime `636becf5` (empreintes sous `openclaw-plugin-mobile-ui/fixtures/payment-guard/`) ;
- `adb`, `set_wifi`, `create_lease`, `mutation_lock`, `restore_lease` et `run_restorer`, modifiés pour la consultation, gardent hors consultation leur comportement historique (délais, bail sans champ de consultation, verrou sans délégation) ;
- une recharge exécute sa commande exactement une fois en Wi-Fi comme en 4G, sans forward ADB ni broadcast ajouté ;
- un bail de recharge n'est jamais admis comme canal de consultation : refus `maxit_guard_required` sans aucun appel ADB.
