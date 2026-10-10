# Captures Gateway S24 — provenance utilisée par R19/R21

Les fichiers JSON proviennent de Claude corePR48, repris exactement de la base runtime6b7c68f, au format {_capture,response}. _capture atteste OpenClaw2026.9.6 (eb377ac), SamsungS24/Termux, le10/10 et nettoyage avant publication. Aucun fichier capture JSON n’est modifié par cette PR ; la copie temporaire usage.status a été remplacée par celle de la base.

R19/R21 utilisent response de usage.status,usage.cost,config.get,models.list etmodels.authStatus. Chaque _capture donne paramètres, latence et limites ; config.get est un sous-ensemble nettoyé, pas une configuration entière. accountEmail/profileId sont des placeholders et ne doivent jamais apparaître dans les réponses publiques.

usage.cost7651ms montre cacheStatus.refreshing,92fichiers périmés et zéros : ceci prouve computing, pas un coût nul. Le scénario frais/nonzero des tests est une variation synthétique explicitement déclarée. Les chiffres de latence réels sont injectés dans les tests de budget ; ces tests locaux ne prouvent pas le temps de réponse du nouvel endpoint en production. Claude fait activation et recetteS24.
