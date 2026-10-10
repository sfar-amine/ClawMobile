# R16 — approbation agent liée et excluant le paiement

GET sans attente CLI, liaison unique au run actif et demandes Gateway fermées ; POST propriétaire avec preuve biométrique liée et resolve unique. Réutilisation du registre et du propriétaire de confirmations existants, reprise atomique uniquement pour un échec prouvé avant effet. Contrat : docs/work/samantha-runtime/contracts/r16.md.

Build, faux CLI/registre/confirmation ECDSA réels et toutes les commandes CI actuelles passent localement ; ci.yml inchangé, nouveau test exécuté séparément. Aucun merge ni effet S24. Éléments pending réels à qualifier par Claude avant activation. Périmètre volontairement conservateur : exec opaque et plugins non prouvés hors paiement restent non décidables.
