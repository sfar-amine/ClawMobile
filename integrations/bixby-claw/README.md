# Bixby → Claw private capsule

Ce dossier est un template minimal pour une capsule Bixby privée qui transmet une
demande vocale libre au relay Claw et renvoie la réponse comme texte/dialogue.

## Avant le test

1. Installer Bixby Developer Studio et se connecter avec le compte Samsung/Bixby du S24.
2. Remplacer `example.clawVoice` dans `capsule.bxb` par le namespace de l'organisation.
3. Dans Developer Center > Configuration & Secrets :
   - configuration `relay.url` = URL stable du Worker `https://...workers.dev`
   - secret `relay.token` = même OWNER_TOKEN que le Worker.
4. Ne jamais stocker le token dans Git ou `capsule.properties`.
## Training POC

Bixby Studio génère le plan de training; ne pas fabriquer les fichiers `training.bxb`
à la main. Ajouter d'abord des exemples FR explicites et bornés :

- « demande à Claw mon solde Orange »
- « demande à Claw mon solde de recharge Maxit »
- « demande à Claw ce que j'ai demain »
- « demande à Claw de chercher <nom> »

Le span après « demande à Claw » doit alimenter l'input `request:Request` de
l'action `AskClaw`.

Commencer par named dispatch / on-device testing pour éviter les conflits NLU.
## Recette

- Utiliser une private submission ou le QR du workspace Bixby Studio.
- Activer Developer Options > On-device testing sur le S24.
- Tester Orange ambigu puis recharge explicite.
- Vérifier une seule exécution physique par `requestId`.
- Vérifier la réponse vocale et la latence.
- Désactiver on-device testing après la recette.

Le bridge externe n'est considéré `live` qu'après cette recette owner-linked.
