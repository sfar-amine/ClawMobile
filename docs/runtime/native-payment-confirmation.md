# Programme de confirmation native des paiements

Composant partagé du runtime Claw sur S24. Le client Python payments.cli appelle le Companion existant ; l'activité PaymentConfirmationActivity de Samantha Android présente l'autorisation au propriétaire. Les sites gardent des adaptateurs distincts.

Seul demo.confirmation est actif et ne réalise aucune transaction. Les autres adaptateurs sont bloqués avant réseau. La seconde étape bancaire et le reçu réel ne sont pas implémentés.

La signature P-256 est liée à la demande exacte, au montant/fournisseur/référence, au mode, à une expiration et à la clé publique épinglée par l'installation. Aucun Intent ni booléen JSON ne peut approuver l'opération. Le registre runs.json conserve les gardes de rejeu, indépendamment de la rétention des conversations. Les lectures et appels sont bornés ; un effet inconnu ne se rejoue pas.

Contrat canonique et usage : dépôt privé samantha-ui-playbooks, payments/README.md et capabilities/howto/payment.owner_native.md. Architecture : ADR-20261003-native-payment-confirmation.md dans ce même dépôt.

Source et tests sont préparés en isolation. L'installation native et la recette matérielle sont suivies séparément ; aucune confirmation Termux antérieure ne vaut preuve pour ce nouveau protocole. Restaurer uniquement l'APK et le runtime précédents en conservant les données et sans rejouer de demande.
