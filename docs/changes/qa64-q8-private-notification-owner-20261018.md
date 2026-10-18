# Q8 — notification privée de lancement dans le propriétaire Termux

Le producteur QA privé réutilise `tx_notify` et le CLI Termux existants. L'outil public conserve exactement ses paramètres `title/content` ; aucun paramètre de commande ou d'action libre n'est ajouté. Le propriétaire QA appelle le script compilé `dist/backends/qaCampaignNotificationCli.js` avec un seul argument : son identifiant de campagne validé. Le titre et le contenu sont constants.

La notification a un identifiant dérivé du run et `--alert-once`. Son action shell ne contient que le chemin absolu de Node, celui du script versionné `qaCampaignNotificationAction.js` et le run. Ce second script revalide l'argument, puis appelle le `am` Termux absolu avec le composant installé `ai.samantha.android.dev/ai.samantha.android.MainActivity`, l'action `ai.samantha.android.OPEN_QA_CAMPAIGN` et exactement les extras `qa_version:Int=1` et `qa_run_id:String`. Aucun URI, texte, destinataire, commande ou sélecteur public n'est accepté. Le clic ouvre uniquement l'app : son verrou et sa lecture du run restent propriétaires.

La phase de publication est bornée à5s ; le clic à5s. Aucun nouvel appel Gateway, stockage, route, ordonnanceur ni retry. `ACCEPTED` indique seulement que Termux a accepté la publication, avec `display_verified=false` et `click_verified=false`. Une sortie incertaine reste `UNKNOWN`. Le propriétaire appelant conserve son reçu durable avant publication et n'effectue pas de relance automatique. Le producteur n'autorise pas une demande, un accès contact ou une campagne ; il reçoit seulement une décision déjà admise par le propriétaire QA. Le raccord PB conserve ces gardes. Aucune option d'auto-annulation Termux n'est supposée.

## Source et vérification

Source publique S24 lue le18/10 : CLI `termux-notification` SHA256 `f02914d2b40c055a12e5fbc1249776539635b7511602945178d74c30c74858ce`, action exécutée sous `dash -c` hors profil/PATH de session ; Node installé confirmé par le wrapper OpenClaw. Le composant a été résolu en lecture seule via le propriétaire ADB installé, sans lancement. La fixture nettoyée `openclaw-plugin-mobile-ui/fixtures/qa-notification-s24-20261018.json` conserve ces métadonnées et leur provenance. La [réponse Claude](https://github.com/sfar-amine/samantha-ui-playbooks/pull/196#issuecomment-6250854589) confirme aussi Termux:API0.53.0 et sa permission existante. Aucune permission de notification de l'app n'est demandée.

Build TypeScript complet passé ;41/41 vérifications ciblées passent (`node scripts/test-qa-campaign-notification.cjs`) et sont inscrites en CI. Le test utilise un faux exécutable Termux et un spawn Android remplacé : il contrôle l'appel réel au backend, les arguments fermés, le script du clic, les refus avant effet, le maintien du schéma public et les limites des reçus. Aucun envoi, notification ou lancement réel n'a été exécuté. La CI canonique sera celle du head exact de la PR runtime Q13 après intégration de ce complément ; ces tests ciblés ne la remplacent pas. La recette d'une notification et d'un clic revient à Claude sur le S24.

## Retour arrière

Revenir au commit précédent de ce complément et retirer son raccord PB ; aucune donnée historique, configuration de permission ou notification existante n'est modifiée. Ce code complète la PR runtime Q13, sans nouvelle PR ni modification de la PR APK Q8.
