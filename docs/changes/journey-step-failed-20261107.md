# Écran de suivi : une étape d'outil en échec n'est plus cochée

**Constat (S24, 07/11 16:07).** L'outil typé Orange a répondu `{"state":"FAILED",…}` avec `isError: false` côté moteur. L'écran de suivi affichait « Je lis ton solde Orange » comme faite (803 ms), alors que la réponse disait qu'aucun solde n'avait été lu.

**Correctif.** L'observateur lit le résultat déjà présent dans la trame d'outil : premier texte, ensemble fermé d'issues `FAILED`, `TECHNICAL_FAILURE` ou `DENIED`. L'étape est alors enregistrée comme une erreur d'outil et affichée « non faite ». Un résultat illisible garde le verdict du moteur.

**Preuve.** `scripts/test-run-journey-steps.cjs`, cas 6, rejoue le résultat réel de 16:07 (`fixtures/s24-2026-11-07-journey-steps/typed-failed-result.json`).
