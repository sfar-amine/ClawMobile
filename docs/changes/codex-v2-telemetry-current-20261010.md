# V2 — télémétrie du protocole historique

Le protocole 1 utilise le producteur C1 opt-in existant : t01 à l’attachement, t07 à ready et t99 à la fermeture, avec sid app fourni ou UUID neuf retourné à warmReady. Aucun tour duplex fictif, contenu, audio, transcript ni changement de cycle fournisseur. Les calibrations sont sérialisées par sid et la fermeture utilise son propre offset, y compris lors d’une nouvelle session immédiate.

Base af4132a ; nouveau test historique et M1 télémétrie 12/12 passent ; CI courante entière CI_LOCAL_OK. ci.yml inchangé. Preuves hors ligne, aucune recette S24 ni activation par Codex. La préférence de voix V5 et l’accélération R5 non fusionnées ne sont pas incluses.
