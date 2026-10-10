# Suivi26 — retouches des lots fusionnés

Une PR Companion regroupe R16 (confirmation inconnue et prélecture), V5 (catalogue français et réchauffage), R14 (bornes HTTP et stockage) et G2 (détection de secrets et timeouts). Les contrats des quatre lots sont mis à jour. Aucun modèle, route duplex, paiement, registre ou scheduler ajouté.

Tests : suites existantes enrichies pour confirmation inconnue/expirée sans CLI, uploads avec headers navigateur et gros corps interrompu, téléchargement non-loopback et sous-dossier, choix Puck puis défaut null au rewarm, maxTokens et préfixes GitHub. Chaque suite est inscrite dans ci.yml, toutes étapes de la base conservées. La recette ajoute POST /attachments refusé sans owner.

Aucune fixture physique ni qualification fournisseur n’est créée par ces tests locaux. Claude relit, fusionne, déploie et qualifie sur le S24. Retour arrière : revert de cette PR, sans suppression des états privés.

Revue GitHub #49 : les délais G2 sont calculés depuis la table READS de companion-acceptance.py (chemin sans requête, budget maximal des doublons, marge de 2 s), sans exécuter la recette. sessionToken et bearerToken sont détectés ; maxTokens et totalTokens restent des compteurs. Les descriptions françaises décrivent chaque voix ; la qualification reste un champ séparé. L’union conserve mémoire, security-surfaces, settle(), LEAK limité aux secrets et les deux gardes HTTP.
