# M3 — curateur audité et projection inter-surfaces

`memory.db` reste l'unique source de vérité. Les événements de `events` restent
immuables. Le curateur matérialise dans la même base une projection reconstruisible
`curated_facts` et un journal append-only `curator_audit`.

- `ADD` enregistre le premier événement source d'un fait avec `valid_from` et
  `observed_at`.
- `UPDATE` n'est appliqué que si l'auteur a fourni `supersedes`. La version
  précédente reçoit `valid_to`; la nouvelle version conserve la racine du fait.
- `INVALIDATE` n'est appliqué que par un reçu canonique `MEMORY_RETIRE_V1` ou
  `MEMORY_FORGET_V1` qui référence le fait.
- Les dates doivent être ISO 8601 avec fuseau. Une date invalide reste hors de la
  projection et figure dans le bilan du passage.
- Les doublons proposés par analyse ne sont pas fusionnés automatiquement. Le
  curateur reste en mode `shadow` jusqu'à M5.

La note bornée `workspace/memory/cross-surface/AAAA-MM-JJ.md` est produite
uniquement à partir des versions actives auditées. Son emplacement appartient à
la racine `memory/` indexée récursivement par Memory Core. Le curateur ne lit ni
ne projette `memory/dreaming/`; le dreaming natif reste désactivé conformément à
R14. La note demeure non normative et renvoie aux événements sources.

La migration ajoute seulement deux tables dérivées dans la base propriétaire et
réutilise le cron, la transaction et le writer existants. Aucun store, daemon,
scheduler ou moteur de recherche parallèle n'est créé.
