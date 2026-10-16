# G4 — reçus de déploiement S24

Capture en lecture seule le 10 octobre 2026 via claw_exec, action codex-g4-deploys-fixture-20261010, steps receipt-metadata-read et receipt-fields-read, exitCode 0. Propriétaires confirmés : companion-deploy.sh et install-from-ci.sh, ~/.openclaw/deploys. 15 reçus Companion, 7 app ; 8 échantillons capturés. Première collecte S24 41,76 ms ; capture enrichie publiée 10,93 ms.

Les samples conservent les champs structurés réels. Les routes, détails libres, sorties et avertissements de recette ont été retirés **sur le S24 avant transport**. Seul detail app conforme exactement à version=<version numérique> run=<entier> est conservé pour prouver le parseur. Les champs dérivés appVersion et kind sont des métadonnées de capture, pas des champs du propriétaire. Aucun échec de recette/rollback présent : les tests négatifs modifient explicitement ces fixtures réelles.
