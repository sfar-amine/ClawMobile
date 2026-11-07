# Garde réseau : l'app Max it d'abord, Wi-Fi gardé (07/11/2026)

## Problème

Le 07/11 à 20:18, sur le S24, le garde `android-network-mutation-guard.py` a coupé le Wi-Fi pour lire le solde Orange.

- Il prenait le couloir `guarded_fallback` (raison `orange_cellular_not_ready`) dès que le Wi-Fi était le réseau par
  défaut sans 4G Orange validée en parallèle. Preuve : `wifi_disabled: true`, `dns_ready_ms: 3312`, `restored: true`.
- En 4G, l'API Orange a répondu `waaat_auth_failed` à 20:25 et à 20:35, même après la connexion d'Amine à Max it.
- Une fois connecté à Max it par la 4G, Amine voit son solde dans l'app sur Wi-Fi.

Décision d'Amine « App Max it d'abord » : Samantha lit l'app Max it sans couper le Wi-Fi. La 4G (Wi-Fi coupé) ne sert
qu'à se reconnecter à Max it (« Se connecter via réseau mobile ») ou quand l'écran est verrouillé (API Orange en 4G).

## Changement

Le déclencheur est la paire consécutive `--mode app` dans la commande enfant (`telecom.maxit_guarded_service`).
Pour tout autre mode, rien ne change.

En mode app, quand la décision est `guarded_fallback` (y compris après la conversion `--no-cellular-channel`) :

1. **Phase A, `app_session_wifi`** : même bail `wifi_off` qu'aujourd'hui, décision
   `{'route':'app_session_wifi','reason':'maxit_app_session_first'}`, `consultation_wifi_toggled=False`, aucun
   `set_wifi`. `consultation_context` admet cette route (sans `selection`). En voix (`--keep-wifi`), le refus immédiat
   `orange_cellular_required_wifi_kept` ne s'applique plus en mode app : la phase A s'exécute.
2. Si l'enfant répond `state: mobile_network_required` avec `reason` `maxit_signed_out` ou `screen_locked` :
   - en voix : `orange_cellular_required_wifi_kept` avec cette raison, code 4, aucune mutation ;
   - sinon, avec au moins `APP_SESSION_ESCALATION_MIN_S = 20` s de budget enfant : **phase B**. Le bail reprend la
     décision `guarded_fallback` d'origine et `consultation_wifi_toggled=True` (écrit avant la coupure, pour le
     restaurateur détaché), puis `set_wifi(False)` et la même commande enfant une seconde fois, dans la même échéance ;
   - sinon : `consultation_budget_exhausted`, code 4, aucune mutation.
3. Tout autre résultat de la phase A est final (chemin `app_session_wifi`, aucune mutation). L'escalade n'a lieu
   qu'après un nettoyage certifié de l'enfant de la phase A.

`cellular_default` lance l'enfant une fois, comme avant. `blocked` est inchangé.
`network_metrics.app_session` vaut `served`, `escalated_maxit_signed_out`, `escalated_screen_locked`,
`declined_wifi_kept`, `budget_exhausted` ou `not_applicable`. La preuve `network_guard` garde exactement ses six clés.
La restauration de fin (bail, reçus, signaux) est celle d'aujourd'hui pour les deux phases.

## Preuves

- Fixture réelle : `openclaw-plugin-mobile-ui/fixtures/s24-2026-11-07-orange-app-session/`.
- Test : `installer/termux-lite/test-consultation-app-session-first.py` (14 tests, inscrit dans `ci.yml`).
  La phase B doit produire la preuve réelle de 20:18. Le test échoue sur le garde de base.
- Tests du garde, des consultations et de l'invariance du paiement : inchangés et verts.

## Retour arrière

Revert de ce commit puis `companion-deploy.sh <commit>`. Le garde reprend le couloir immédiat en mode app.
Aucun réglage Android à restaurer.
