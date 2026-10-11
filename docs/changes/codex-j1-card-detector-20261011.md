# J1 — réduire les faux positifs sans ignorer les tests

Le scanner existant écarte les horodatages et identifiants structurés prescrits par le backlog 42 tout en conservant les cartes isolées. Une politique statique admet des signatures exactes de tests publics attestés, avec trace `accepted` dans le reçu existant, sans exception globale de fichier ni retrait des protections privées. Toutes les collections partagent les limites existantes ; budget inchangé.

Les nouveaux tests génèrent leurs valeurs numériques ; aucune valeur littérale de carte ou d'horodatage ajoutée. Suite complète locale et recette S24 encore en attente. L'objectif 332/346 n'est pas une mesure obtenue ; Claude fournit la capture nettoyée avant/après et déploie après revue. Aucune nouvelle route, capability, service, store ou fichier du module paiement. Retour arrière par revert sans migration. Contrat : `docs/work/samantha-runtime/contracts/j1-card-detector.md`.
