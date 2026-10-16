# Fichier 52 — préchauffage et budget de la voix

Le propriétaire reste `ClawLiveWarmCore`. Aucun nouveau service, store, routeur ou moteur de reprise n'est ajouté.

## Garde de préchauffage

Lorsqu'un changement de conversation appelle le préchauffage pendant la fermeture normale de l'ancienne socket, le propriétaire attend sa libération pendant au plus 750 ms. Si elle se libère, le préchauffage demandé prend la place du préchauffage générique après détachement et réutilise la connexion partagée existante. Si l'owner reste actif, la réponse demeure `voice_owner_busy`. L'attente est bornée à huit appelants et à deux secondes même avec une valeur injectée en test.

Cette garde ferme la course observée où l'app fermait une conversation, recevait `voice_owner_busy` sur le nouveau préchauffage, puis ouvrait la voix à froid. Elle ne modifie ni le protocole v2 de #251/#252, ni le choix acoustique, ni l'interface.

## Télémétrie du budget

Le schéma existant `samantha.voice.telemetry.v1` et son fichier JSONL restent propriétaires. Aucun texte, transcript, audio, capability, modèle ou secret n'est journalisé.

- `t07.x.cached` indique si l'attachement a trouvé Gemini Live déjà prêt.
- Le premier audio Gemini d'attente garde `t30p.x.phase=0`.
- Le premier audio du résultat après `receiptReply` porte `t30p.x.phase=1`, `warm_hit`, `decision_ms`, `capability_ms`, `gemini_ms`, `response_ms`, `budget_ms=5000` et `budget_exceeded`.
- `response_ms` va de `t25p` (fin d'activité relayée au fournisseur) au premier audio du résultat. `gemini_ms` va du `receiptReply` à ce premier audio. Les durées sont entières, positives et bornées à dix minutes.

L'analyseur existant expose les hits/miss de préchauffage et décompose décision, capability, Gemini et durée totale. Il ne transforme pas une simulation en recette physique : la cible produit reste moins de cinq secondes entre la fin réelle de parole et le début audible de la réponse. Claude qualifie cette cible sur le S24 avec les événements app `t23`/`t32` et les 20 phrases prévues au calme et en voiture.

Le budget est une garde de qualification et de diagnostic. Un dépassement ne coupe pas une réponse en cours et ne rejoue aucune capability.
