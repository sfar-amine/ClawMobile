# Zéro désynchronisation : consignes, contrôle permanent, règles des playbooks (12/10/2026)

Décision d'Amine : « je ne veux pas de désynchronisation ». Ce changement suit #229 (copies du code) et #230 (règle « ne jamais inventer »).

## Ce qui restait ouvert
- **Consignes des pièces Projet et Pulse.** Elles n'étaient écrites qu'à la construction du dossier.
- **Consignes des contacts simples.** Elles n'existaient que sur le S24, sans source.
- **Règles globales des playbooks.** Elles n'étaient pas réinstallées à l'épinglage. La règle « ne jamais inventer » a dû être posée à la main.
- **Écarts apparus entre deux déploiements.** Une modification à la main, une réinstallation, ou une mise à jour d'OpenClaw qui change ses hooks (comme `inbound_claim` le 12/10) : aucun contrôle ne les voyait.

## Changement
- `runtime-sync.sh` met aussi à jour :
  - les consignes des pièces, par `project-room.py rules` et `pulse-room.py rules` ;
  - les consignes des contacts, depuis `contacts-agent.md`.
- `runtime-sync.sh --check` ne modifie rien et liste chaque écart :
  - plugin de la passerelle, release Tier0, outils ;
  - consignes des pièces et des contacts ;
  - règles des playbooks (`install_interaction_rules.py` en essai : `planned` signale un écart) ;
  - contrat OpenClaw (`runBeforeDispatch` présent dans la passerelle).
- Un déploiement échoue, puis revient en arrière, si OpenClaw n'exécute plus `before_dispatch`.
- `samantha-health-manager.sh` lance `check_runtime_drift` toutes les 30 min. En cas d'écart, il écrit un journal et envoie une seule alerte `human_required` par signature d'écart.
- `activate-ui-playbooks.sh` lance `install_interaction_rules.py --apply` depuis le commit activé, y compris quand ce commit est déjà actif. Un échec sort avec le code 4.

## Tests
`test-runtime-sync.py` (8 cas, dans la CI). Il couvre notamment :
- un écart par type de copie ;
- un `--check` qui ne modifie rien ;
- les écarts apparus après un déploiement (modification à la main, règle des playbooks absente, OpenClaw sans `before_dispatch`) ;
- le branchement dans le gestionnaire de santé et dans l'activation des playbooks.

`test-project-room.py`, `test-pulse-room.py` et `test-activate-ui-playbooks.sh` passent sans changement.

## Retour arrière
Revenir sur ce commit. Les consignes redeviennent manuelles et le contrôle périodique s'arrête.
