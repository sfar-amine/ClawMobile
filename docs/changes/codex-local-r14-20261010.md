# R14 — livraison locale

Extend existing attachment storage with bounded safe file shares and R3 cleanup

Validation : Build and full CI_LOCAL_OK; storage and native HTTP tests cover limits, retention, signatures, collision, receipts, protected attachments and R3 deletion.

Branche isolée préparée pour PR ; Claude relit, fusionne, active et recette. Aucun merge ni déploiement par Codex. Retour arrière : revert du commit de ce lot.

Relecture 17 : All runtime CI commands passed; file-hash replay, unchanged run history, HTTP image upload, missing attachment 404, quota/retention, appendAttachmentContext and R3 cleanup verified. Delta poussé pour relecture ; aucune fusion ni activation.

Bases `639ae68` puis `9a04980` intégrées par merge ; routes et étapes CI préservées. Le helper natif commun est celui de la base. Documentation protocole et installer alignée : en-têtes/id requis, rétention des fichiers référencés, quota_full, anciens .img et 404 des références inconnues.
