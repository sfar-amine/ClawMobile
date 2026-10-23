# Samantha : accès propriétaire avec consentement OAuth

Amine demande d’ouvrir les accès techniques pour fluidifier le Chantier 2. Le
connecteur Samantha est réglé en `full_access`, mais sa connexion OAuth reste
limitée à la lecture par le code historique. La nouvelle page de consentement
offre un choix propriétaire explicite après vérification de l’identité Google.
Une nouvelle portée et une propriété de consentement concordantes sont requises
pour ce profil ; les anciens grants de lecture restent inchangés.

Les tests existants sont enrichis : politique propriétaire/lecture, rejet des
grants incohérents, consentement lisible et échappement des données client,
palette réelle `tools/list` dans Workerd local avec AS synthétique. Les huit cas
historiques sont conservés, trois cas RPC sont ajoutés. Les tests sont déjà
déclarés dans la CI, sans suppression ni nouvelle suite sur le S24.

La politique et le rendu passent 22 assertions locales. La CI complète sur head
exact, le test RPC enrichi et la recette OAuth réelle restent à exécuter.
Aucun succès de mise en production n’est déduit de ce document.

Le [contrat de consentement](../08-decisions/ADR-20261023-chatgpt-owner-consent.md)
précise l’autorité, les droits, l’ordre de publication, la reconnexion nécessaire
et le retour arrière. Pas de nouvelle route, capability, base ou service.
Les commandes Shell du Cloud restent soumises au sandbox de la plateforme.
