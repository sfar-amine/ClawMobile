# P1 — Admission owner provenant du host

Le tool compact est créé depuis le contexte trusted du tour OpenClaw. `caller`
ne peut plus promouvoir un appelant non-owner. Un argument contradictoire,
une exécution sans identité ou une preuve live révoquée est refusé avant tout
helper. Aucun parcours de paiement ni route HTTP n'est modifié. Les tests de
registration et d'admission pour quatre surfaces sont ajoutés à la CI.
La capture du contexte factory sur le S24 reste à Claude avant qualification.
