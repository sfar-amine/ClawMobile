# M1 — relecture technique 0.4

Source lue : docs/work/samantha-android/27_CONVERGENCE_LOT0_CONTRACTS.md à e5bd3a4a60e5eae1492dd3b9899e288431f55126, branche privée feature/samantha-lot0-app-20261009. Comparaison avec les spécifications et le plan du dossier Samantha-Convergence fourni.

Résultat : C1–C4 sont cohérents comme contrats normatifs v1 ; aucun changement de schéma proposé. Relecture technique terminée. Ce document n'est ni un acquittement S24 ni une validation d'implémentation/live. C5 décrit l'ownership historique ; les branches actives et checkpoints S24 doivent être réconciliés avec le split actuel communiqué par Amine avant intégration.

## Points impératifs de recette

- C1 : utiliser CLOCK_BOOTTIME réellement, pas Date.now() ni process.hrtime comme substitution non qualifiée. Companion est TypeScript sur la branche publiée ; l'accès à CLOCK_BOOTTIME doit être démontré par le mécanisme existant/qualifié, sans nouvelle horloge parallèle. Suspend/reprise et reboot doivent être distingués dans les preuves.
- C1 : même sid/epoch côté app et Companion, turn corrélé ; t44 doit conserver src pour distinguer ses deux émetteurs. Pour un prewarm sans propriétaire, ne pas inventer un sid app ; l'analyse doit traiter explicitement le rattachement ou le manque de corrélation.
- C1 : t32 marque le frame joué, pas seulement le write AudioTrack. t20/t23/t40 sont des annotations externes, pas des événements device inventés. Préserver les unités ns/ms et les événements manquants.
- C1/C2 : x technique borné, flags actifs au t00, aucune parole/transcript/audio/token dans les logs. Flags changés uniquement entre sessions ; release sans VoiceLab.
- C3 : les 19 catégories et six attentes sont ceux du contrat ; REQ-1652 doit conserver expect=reject. Les stimuli du corpus ne sont pas du contenu de télémétrie.
- C4 : tests de schéma sur les routes listées et les messages protocol=2 ; les endpoints UX supplémentaires ne sont pas considérés livrés par ces seuls tests. Une rupture implique v2 et validation du consommateur Android.
- KPI : sans N >= 100 dans le groupe réellement analysé, ne pas annoncer un P95 qualifié. Les sorties doivent indiquer N, exclusions, échantillons manquants, erreurs et contrôle d'alignement externe.

## État Git distant observé

- Companion privé : runtime/samantha-companion-private à 177edcaa70ff8a9c6a8868a3077525668c1f602c.
- Branche app Phase 0 : e5bd3a4a60e5eae1492dd3b9899e288431f55126.
- Branche Android UX active annoncée, HEAD distant lu lors du recheck : 0295184d7aa76d059237aed4ab1b810e66a4e328.
- Le même nom de branche Companion sur le dépôt public pointe vers 9559da87fe96cab45fd00bfe17f95279423a5eca : ne pas les confondre.
- A9/A10 désormais publiés sur feature/samantha-m1-corpus-20261009 à e016d020d53b4ecc5eee475536fc3097173a0e12 (parent 177edca). Les six tests sont vérifiés dans cette livraison. Leur code reste inchangé.

## Suite canonique

Rattacher cette relecture au checkpoint existant 0.4, récupérer branche/SHA/diff du travail A9/A10, vérifier les prérequis ci-dessus avant acceptation M1. Aucun événement S24, merge ou runtime n'a été exécuté ici.

## Acquittement 0.4 à enregistrer dans S24

Relecture normative C1–C4 v1 acceptée par ChatGPT/Codex ; contraintes de recette conservées. C5 doit suivre l’ownership actuel du checkpoint d28b0f37… transmis par Amine. Rattacher ce résultat au taskId/stepId existants retrouvés dans ce checkpoint ; ne pas créer une nouvelle mission. L’écriture S24 n’a pas été effectuée : aucun outil Claw d’écriture n’est exposé ici. Ce document versionné constitue la preuve de relecture, pas le reçu d’acquittement canonique.
