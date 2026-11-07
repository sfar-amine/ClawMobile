# Garde réseau : retrait du parcours « app Max it d'abord » (07/11/2026)

#568 avait ajouté à la garde réseau un parcours pour les commandes `--mode app` : lecture de Max it avec le Wi-Fi gardé (route `app_session_wifi`), puis escalade vers le couloir Wi-Fi coupé si Max it était déconnecté ou si l'écran était verrouillé.

Le soir même, Amine a choisi « API, pas de fallback en ouvrant Max it ». Côté playbooks :
- le solde passe par l'API seule (`--mode silent`) ;
- le mode `app` est supprimé (samantha-ui-playbooks#417, activé) ;
- les autres lectures Orange n'ont plus de repli Max it (samantha-ui-playbooks#418).

Aucune commande ne porte donc plus `--mode app`, et ce code de la garde ne s'exécute plus. Il est retiré : la garde revient exactement à son état d'avant #568, et le test `test-consultation-app-session-first.py` et son étape CI sont supprimés. La note et la fixture de #568 restent comme historique.

Recette réelle du nouveau parcours (app, 23:04) : solde complet, chemin `cellular_bound_wifi_unchanged`, `wifi_toggled: false`, `ui_used: false`.
