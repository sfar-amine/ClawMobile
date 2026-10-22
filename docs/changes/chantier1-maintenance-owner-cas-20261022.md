# Chantier 1 — Ne rouvrir que sa propre fermeture de maintenance

Le propriétaire de maintenance accepte une réouverture conditionnelle sur l’epoch et la révision de son marker existant. La comparaison et l’écriture se font sous le verrou propriétaire ; une fermeture urgente intermédiaire, y compris à epoch identique, empêche la réouverture.

L’API legacy conserve ses epochs. Le laboratoire découvre explicitement la capacité version 1 avant tout effet ; un propriétaire plus ancien ne reçoit jamais les arguments de CAS supposés. Le verrou et le marker sont ouverts sans suivre un symlink ni bloquer sur un FIFO. Aucun service, store, routeur ni démon ajouté.

Le vrai script est testé sur un HOME temporaire : 10/10 nouveaux contrôles et 3/3 anciennes régressions maintenance verts. Ces résultats ciblés ne remplacent pas la CI canonique exacte de la PR. Aucune activation ou sonde téléphone n’a été exécutée dans ce lot.

Architecture : [décision et compatibilité](../08-decisions/ADR-20261022-maintenance-owner-state-cas.md).

Retour arrière : revert limité au propriétaire CAS et à ses tests/docs. Le client laboratoire refuse un ancien propriétaire avant fermeture/activation ; les contrôles de maintenance hors chantier restent inchangés.
