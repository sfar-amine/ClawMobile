# #126 : ré-application de #516 (hooks de profil via la session de l'hôte) — 2026-11-02

#516 avait été retirée par #517 : les outils typés étaient refusés en prod. La cause réelle n'était pas #516 mais la preuve d'admission propre à chaque copie du plugin chargée par OpenClaw 2026.10.9 ; #517 l'a rendue commune au processus (en prod depuis 50fd056c, recette 5/5).

Ce changement ré-applique le code de #516 : dans la Gateway, les hooks de profil de modèle utilisent `api.runtime.agent.session` et `api.runtime.config` au lieu d'importer le SDK de session par URL de fichier, ce qui supprimait la recopie de 190 Mo (41,9 s) dans la capture à chaque redémarrage.

## Garde-fous
- La recette échoue sur tout refus d'admission typée ou `TECHNICAL_FAILURE` (#517, #518).
- Le retour arrière automatique restaure aussi la Gateway (#517).

## Retour arrière
Revert du merge, puis companion-deploy vers le commit précédent.
