# R11 — Métadonnées et pagination des conversations

La liste rend sa page sans attendre le CLI Gateway : index propriétaire rafraîchi en arrière-plan, cache court single-flight, titre/épingle/source conservés après panne et curseurs stables sans nouvelle preuve. Les lectures de mutation et readback gardent leur autorité fraîche.

Têtes relue8b03244 et runtime0bf30ab intégrées par merges, routes et CI conservées. Budgets acceptance : liste300ms, détail10s sur un fil réel. Sans fil, détail explicitement non qualifié.

Validation : tests mutations/ledger et cache sous délai synthétique4,15s, tests budgets, CI complète et gate. Aucune preuve S24 inventée ; Claude qualifie avant activation. Retour arrière : revert de la PR.

Lecteur modèles partagé avec R6 : single-flight, cache sélectionné sans secret de 60 s, rafraîchissement borné à une fois par 30 s, échéance de lecture de cache 5,5 s. Les mutations continuent à relire les propriétaires et gardent leurs gardes et leur CAS. R19/R21 devront réutiliser ce module ; leurs routes ne sont pas livrées ici. R18 reste en attente des captures réelles : aucun changement du contrat `/metadata`, aucun objectif 6 s déjà revendiqué.
