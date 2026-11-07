# Écran de suivi : vraies étapes, réflexion, synthèse et Cancel (07/11/2026)

Demande d'Amine (07/11, capture de l'écran de suivi de « mon solde orange ») : voir les étapes synthétiques, la réflexion et une synthèse, et rendre le bouton Cancel fonctionnel. Les libellés de l'app restent en anglais.

## Constat sur le S24
- L'écran n'affichait que « Demande reçue » puis « Réponse de Samantha ».
- Le cerveau appelle des outils typés (`samantha_maxit_tunisie`, `samantha_agenda`…), directement ou par l'enveloppe `tool_call`. Ces appels n'ont pas de titre : ils n'étaient jamais des étapes.
- Les identifiants d'appel réels sont `call_<hex>|fc_<hex>`. Le Companion refusait le `|` : même un appel titré n'était jamais enregistré.
- Le modèle (`gpt-5.6-sol`) envoie un résumé de réflexion sur le flux `thinking` (« **Identifying need for call balances** »). Le Companion l'ignorait.
- Un arrêt par `chat.abort` se terminait en « résultat à vérifier », puis en relecture de l'historique.

## Changement
- **Étapes réelles.** Chaque outil typé connu devient une étape en français, d'après l'outil et l'action seulement : « Je lis ton solde Orange », « Je consulte ton agenda », « Je regarde tes factures STEG »… L'enveloppe `tool_call` est dépliée. Un appel imbriqué dans un appel déjà affiché ne crée pas de seconde étape. Les outils internes (fichiers, shell, découverte, sessions) restent invisibles.
- **Durées.** Une étape terminée porte sa durée mesurée, du début de l'outil à son résultat. La réponse porte la sienne, depuis le dernier résultat d'outil. Un tour terminé porte son temps total.
- **Réflexion.** Seuls les titres du résumé sont gardés, au plus 6. Le corps n'est jamais gardé. Un titre avec un identifiant, un chemin, un fichier, un lien ou un long nombre est écarté. Le Companion écrit au plus une mise à jour à la fois, et le règlement final reprend tout.
- **Cancel.** `progress.stoppable` indique un tour admis, suivi et en cours : la même preuve que le propriétaire d'arrêt existant. Avant le `chat.abort` officiel, le tour reçoit `ownerStop: requested`. Il passe à `acknowledged` si l'arrêt est confirmé, et la marque est retirée si rien n'a été arrêté. Le tour arrêté se termine en `failed` avec « Tu as arrêté cette demande… » et `progress.stopped`, sans étape en échec. Une réponse vérifiée arrivée avant l'arrêt est gardée.
- Identifiants d'appel acceptés : `^[A-Za-z0-9_.:|-]{1,200}$`.

## Tests
- `test-run-journey-steps.cjs` (nouveau, dans la CI) rejoue deux tours réels du S24 (fixture `s24-2026-11-07-journey-steps`) :
  - étapes françaises et leurs durées : Orange 14 564 ms puis réponse 3 432 ms, total 21 661 ms ; agenda par l'enveloppe ;
  - titres de réflexion filtrés ;
  - arrêt dont la fin arrive avant la réponse de `chat.abort` ;
  - arrêt sans effet : la marque est retirée et la réponse normale est gardée ;
  - perte du transport après un arrêt : le tour se termine quand même en arrêt.
- Inchangés et verts : `test-run-progress*.cjs`, `test-gateway-run-observation.cjs`, `test-generation-interrupt.cjs`, `test-voice-waiting-cues.cjs`, `test-voice-run-poll.cjs`, `test-voice-turn-stages.cjs`, `test-run-payment-presentation.cjs`, `test-companion-runs.cjs`.

## Retour arrière
Revenir sur ce commit et redéployer le Companion précédent. Les champs ajoutés (`durationMs`, `totalMs`, `reasoning`, `stoppable`, `stopped`, `ownerStop`) sont optionnels : l'ancienne app les ignore.
