# F3 — localisation de présentation, préparation locale

Les réponses serveur existantes choisissent une présentation française ou anglaise via Accept-Language, sans modifier les codes du protocole ni les contenus utilisateur. Les composants santé utilisent leurs libellés bilingues existants ; les intervalles capturés sont lisibles en anglais. Projection sans appel Gateway ni modification du cache source.

Build et test-server-localization.cjs réussis : fixtures santé et automatisations S24, langues, intégrité des textes utilisateur, cache partagé inchangé et vrai handler HTTP. Toutes les étapes CI existantes restent présentes. Contrat : docs/work/samantha-runtime/contracts/f3.md.

Préparation locale partielle : descriptions libres non traduites faute de provenance structurée ; signal de langue app à confirmer par Claude dans la future PR. Aucun push, merge, déploiement ou effet S24.
