# Captures S24 du 10/10/2026 (règle P0-2)

Ces fichiers ont été capturés par Claude sur le S24 (Companion `a841936`, playbooks `2ba0e72`), puis nettoyés sur le téléphone avant d'être publiés.

## `control/` : Contrôle contrat 2, réponses réelles du Companion
- `health.json` : `GET /v1/control/health?contract=2`. Composants réels avec leurs libellés R1 (`label.fr` et `label.en`), 18 sur 18.
- `requests.json` : `GET /v1/control/requests?contract=2`, environ 40 Ko.
- `automations.json` : `GET /v1/control/automations?contract=2` (R5).
- `latency.txt` : latences mesurées sur le S24 au moment de la capture.

**Nettoyage.** Les identifiants, statuts, références, dates, révisions et libellés `fr`/`en` sont conservés. Tout autre texte libre (titres, descriptions…) est remplacé par `<texte N car.>`. Les numéros sont masqués en `+21600000000`. Une recherche de secrets a été faite avant publication.

## `r8/` : format réel de `skill_candidate.json`
Ce sont les 5 seuls `skill_candidate.json` présents sur le S24, produits par le vrai code `trace_induction` lors des essais du 02/10, à partir de traces de démonstration (`mock_trace`, app d'exemple). **Le S24 n'a aucun dossier `<workspace>/recordings/` réel** : aucune démonstration réelle n'a encore été enregistrée.

Conséquence pour R8 :
- le format (`schema_version: clawmobile.skill_candidate.v1`, `steps[]`, `validation`…) est celui que le code réel produit ;
- le volume réel est **0**. Le test au-delà de 500 dossiers reste un test de bornes, généré à partir de ces formes.
