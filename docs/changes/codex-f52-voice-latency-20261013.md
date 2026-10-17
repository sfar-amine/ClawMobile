# Fichier 52 — garde de préchauffage et budget Voix

La course fermeture→nouvelle conversation n'abandonne plus le préchauffage sur `voice_owner_busy` : le propriétaire Warm attend le détachement pendant une fenêtre bornée, puis démarre la demande exacte. La télémétrie existante distingue désormais le premier audio d'attente du premier audio de résultat et mesure les étapes décision, capability et Gemini sous le budget de 5 s.

La preuve locale injecte une horloge monotone : décision 100 ms, capability 2 900 ms, Gemini 400 ms, résultat à 3 600 ms après `t25p`, sans réseau ni action réelle. Elle qualifie le contrat et le verdict de budget, pas la latence physique du S24. La recette sur 20 phrases, avec `t23`/`t32`, reste à Claude.

Aucun changement visuel, paiement, Kokoro/Piper, route, capability ou modèle. Retour arrière : revert de cette PR ; le Warm revient au refus immédiat pendant la fermeture et les lecteurs ignorent les nouveaux champs techniques.
