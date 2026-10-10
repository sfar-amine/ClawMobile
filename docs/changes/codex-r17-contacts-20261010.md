# R17 — liste blanche WhatsApp complète

Lot unique intégré sur runtime `af4132a` : extension people-trusted, adaptateur Companion, contrôles HTTP et biométrie, reçus/rejeu, contexte privé, activité réelle et balayage dans le cycle health-manager existant. Aucun paiement, nouvelle table, store, registry, scheduler ou daemon.

Validation : 28 tests owner R17, trois tests du cycle health-manager, 21 tests people-trusted existants, matrice HTTP, test croisé HTTP → vrai contrôleur → SQLite/config CAS de fixture, build et commandes CI existantes. Reprise avant effet avec preuve signée consommée une seule fois ; une autre opération ne peut réutiliser cette preuve. Unicode (2000 caractères, y compris JSON échappé) et taille physique HTTP testés. Aucun numéro, nom ni note dans l'historique public ou les diagnostics.

Les étapes CI sont conservées ; les nouveaux tests sont exécutés séparément pendant l'inscription coordonnée des étapes. Le contrat précise les bornes du balayage et la qualification restant à Claude. Aucun déploiement ou recette S24 par Codex. Retour arrière : revert du lot.

Revue 26 : suppression complète des contacts suspendus/expirés, règles retirées, bloc supprimé, reste privé archivé ; sweep avec lecture fraîche et nouvelle identité après résultat incertain ; notes = reste du fichier, lecture longue signalée partial/truncated ; historique terminal avec scope/durationDays ; pagination bornée au-delà de 200 contacts. Toutes les réparations existantes du health manager gardent leur comportement. Tests R17 inscrits dans la CI Companion et routes de lecture dans acceptance (10 s provisoires), filtre LEAK exempté uniquement sur items[].e164 de la liste exacte.

Validation locale : 28 tests owner, 3 manager, 2 acceptance, 21 People, HTTP matrice et test croisé HTTP/SQLite-CAS. Toutes les fixtures sont synthétiques. P0-2 réel absent et budgets physiques non mesurés ; merge_eligibility reste blocked. lastActivityAt reste null tant que le dernier message reçu n’est pas attesté. Claude doit relire le delta des mêmes PR, fournir les captures et qualifier le S24 ; aucune activation Codex.
