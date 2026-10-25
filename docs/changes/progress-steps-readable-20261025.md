# Avancement lisible même sans carte de progression (25/10/2026)

Demande d'Amine du 25/10 à 10:46 (point E du chantier Voix v2).

## Constat (S24)
Course `run_1792920553461_9ffdf172` (« détail du blocage », 10:29) : l'app affichait six « Lecture de fichiers · terminé » et des « Outil interne ». Ce sont les six relectures de règles du démarrage (`OPERATING_RULES.md`, `interaction-fast-path.md`, `manifest.json`, `engineering.md`, `memory.md`, `HYBRID_CONTEXT.md`) et des recherches d'outils et de mémoire.
- Aucune `progress_card` n'a été écrite.
- L'agent titre pourtant chaque `exec` (`arguments.title`), par exemple « Lire le checkpoint Voix v2 ».
- La dernière étape gardait l'icône « en cours » même terminée.

## Changement (`runProgress.ts`, `runs.ts`)
Sans carte, les étapes d'une course Gateway suivent ces règles.
1. **Titre de l'agent** : un appel d'outil n'apparaît que par le titre écrit par l'agent (`arguments.title`, lu dans le transcript ou `chat.history`).
2. **Démarrage** : les lectures des fichiers de contexte canoniques deviennent au plus une ligne, « Je prépare ta demande ».
3. **Fusion** des étapes identiques consécutives : une reprise sous le même titre ne compte qu'une fois, dans l'état de la dernière tentative.
4. **Jamais de nom d'outil.**
   - Les appels sans titre (`tool_search`, `tool_call`, `memory_search`, `process`, lectures hors contexte) ne s'affichent pas.
   - Les libellés techniques du transport (« Calling exec. », « Completed. », etc.) non plus.
   - Le texte en direct (`progress.text`) suit l'étape en cours au lieu d'un libellé technique, seulement pendant que le run travaille : un run terminé garde son texte (une précision en attente n'est pas un avancement).
5. **États cohérents** :
   - une étape est en cours jusqu'à son résultat, puis terminée ;
   - un appel en erreur est « non abouti » (`skipped`), et l'issue de la course reste portée par l'étape « Réponse de Samantha » ;
   - une course terminée ne garde aucune étape en cours ;
   - si rien de titré n'est en cours, c'est la réponse qui est en cours.

Les événements lisibles non outils (libellés métier) gardent la règle historique. La carte de progression, quand elle existe, reste prioritaire (#407). L'historique d'événements conservé passe de 12 à 48, pour garder les titres d'une course longue ; au plus 8 étapes sont affichées.

## Routes, budgets, capacités
`GET /v1/runs/{id}` : même lecture, projection seulement, aucun appel Gateway en plus. Aucune capacité ajoutée ou modifiée. Paiement inchangé.

## Tests
- `scripts/test-run-progress-titles.cjs` (7 cas, inscrit en CI), sur la capture S24 réelle de la course (`fixtures/s24-2026-10-25-progress-titles/chat-history-run.json`, nettoyée ; provenance et empreinte dans le fichier).
- `test-run-progress-card.cjs` : le cas « sans carte » attend désormais l'absence de nom d'outil. `test-run-progress.cjs` et `test-companion-runs.cjs` sont inchangés et verts.

## Côté app
Aucun changement requis : l'app affiche tel quel un libellé non technique (`StepLabel.humanize`) et dessine l'icône selon l'état reçu.

## Retour arrière
Revert de ce commit puis `companion-deploy.sh` du commit précédent.
