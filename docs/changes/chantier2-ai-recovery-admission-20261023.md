# Chantier 2 — décision IA avant réparation déterministe

Mandat direct d’Amine du 23/10 : Sol puis Luna choisit chaque action immunitaire,
Codex développe le système. Les callbacks fixes gardent leurs permissions,
budgets, preuves de repos, protections de déploiement, vérification et frontières
humaines. Une sonde échouée seule ne déclenche plus les réparations concernées.

Les adaptateurs shell/Python appellent le propriétaire d’admission des playbooks
épinglés. L’absence de ce propriétaire refuse l’action. Les superviseurs, HTTP,
ADB, readiness Wi-Fi, SSH, Slack, mémoire Gateway, RDC et rollback de surveillance
conservent leurs mécanismes ; ils exécutent un workflow choisi, pas une commande
libre issue du modèle. La mémoire Gateway observe avant décision et ne réserve
son cooldown qu’après choix IA et revalidation native du repos.

La requalification d’incident utilise son identifiant exact. Elle ne ferme pas
un autre incident récent du même composant. L’épuisement du budget de modèle
reste en attente de revalidation au lieu de créer une fin artificielle qui
favoriserait de nouveaux tickets identiques. Les parcours de paiement et gardes
réseau déjà autorisés ne changent pas.

Activation appariée obligatoire avec le lot playbooks Sol/Luna. Les tests des
réparateurs utilisent désormais une sélection IA explicitement synthétique pour
leurs effets contrôlés ; les tests d’admission exercent aussi le refus sans IA.
Aucune recette native n’est déduite de ces fixtures. CI canonique exacte hors S24
avant déploiement ; recette réelle et ménage legacy suivis dans le checkpoint C2.

Le raccord shell capture `BASHPID` avant la substitution de commande et transmet
ce PID à l'admission. La preuve d'arrêt porte ainsi sur l'exécuteur du callback,
y compris en arrière-plan. Un test distinct compare l'identité enregistrée à
celle du callback effectivement exécuté.
