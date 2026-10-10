# C1 — socle canonique des tours app et Bixby

Les tours propriétaires existants transmettent le contexte compact du lecteur canonique aux paramètres Gateway attestés, sans ajouter de route, store ni autorité fournie par le modèle ou le corps client. Admission HTTP et relais authentifié, gardes paiement/confirmation et contenus utilisateur inchangés.

Baseline réelle #82 de huit sessions app/Bixby conservée ; tests fixtures, bornes UTF-8/JSON, règles spécialisées complètes, isolation public/owner et propagation learn/try inscrits dans la CI. Les mesures locales synthétiques restent distinctes des vrais jetons et runtimeMs.

Claude autorise la relecture/fusion avant qualification physique dans [PR71 commentaire6102103806](https://github.com/sfar-amine/samantha-core/pull/71#issuecomment-6102103806), 10/10 20:57:49Z : merge_eligibility:allowed. physicalAfter:null et comparisonQualified:false restent publiés. Après déploiement par Claude, tour app et Bixby jetables, même systemPromptReport et comparaison ±10% ; hors tolérance revert C1 seul ou correctif. La recette automatique ne mesure pas ce critère. Aucun merge ou déploiement par Codex.

Base bfa210c intégrée normalement, union CI conservée. Contrat docs/work/samantha-runtime/contracts/c1.md ; retour arrière C1 seul, propriétaires existants et paiement préservés.

Sur bfa210c fusionné normalement, les 34 blocs run ci.yml passent localement (dépendances plugin présentes, installation MCP avec cache temporaire). PhysicalAfter reste null et comparisonQualified false ; seuls critères pré-fusion déclarés satisfaits.
