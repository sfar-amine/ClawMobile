# G3 — runbooks du runtime natif actuel

Revue26 corrigée sur la base0bf30ab : outils runtime (journal, shell et redémarrage), vue owner claw-live et récupération ADB native f64513f ajoutés. Le déploiement sûr #35 est fusionné f1e1800, son rollback du checkout/dist reste distinct du pointeur Tier0. G2 et les lots fusionnés sont identifiés sans inventer de recette physique.

Sources : server.ts, control.ts, claw_live_control.py, companion-deploy.sh, tier0-control.py et correctif Android f64513f. Diff documentaire seulement ; toutes étapes CI et scripts conservés. Liens et interfaces vérifiés, diff --check et gate de livraison. Aucun nouveau test runtime pour ce changement documentaire.

Claude garde les activations, retours arrière et preuves S24 ; Codex ne les exécute pas. Contrat : docs/work/samantha-runtime/contracts/g3.md.
