# Corps des skills préchargés (#126) — projection source du 02/11

`skills/<nom>/SKILL.md` : corps des quatre skills que le préchargement de `ownerSkillPreload.ts` peut injecter, à l'octet
près, tels que la source les publie (`samantha-ui-playbooks` `de922be4e6349b43560bde1912b0d7a8811653af`, dossiers
`agenda`, `billing`, `telecom`, `device`). Sur le S24, l'activation des playbooks (`activate-ui-playbooks.sh` →
`tools/install_interaction_rules.py --apply` → `context_foundation.skill_files`) les recopie sans les modifier dans
`~/.openclaw/workspace/skills/<nom>/SKILL.md` (test `test_activation_installs_these_skill_bodies_in_the_workspace` des
playbooks).

Ce n'est pas une capture S24. Recoupement : les empreintes S24 du 25/10 (`../s24-2026-10-25-foundation/sdk-context.json`)
de `samantha-agenda` (`d3f2b362…`), `samantha-factures` (`f0ea7084…`) et `orange-telecom` (`478e069f…`) sont exactement
celles des versions source de l'époque (playbooks `489834ba` et `b40dcbeb`). La capture des empreintes en production
après activation remplacera cette projection (voir `provenance.json`).

Aucun secret, aucune donnée de compte : ce sont des consignes publiques du dépôt.
