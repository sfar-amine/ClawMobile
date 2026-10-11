# HS8 — continuation du mémo dans le propriétaire des runs

Complète le [contrat SDK HS8](hs8.md). Le garde `MEMO_STT_QUALIFICATION` reste fermé : aucune transcription produit ni activation du micro n'est qualifiée. Le catalogue dérive `inputs.voiceMemo` de ce même garde ; il reste `available:false`. Les exports SDK, les captures de runs et la présentation HS3 déjà présentes ne constituent pas une recette audio réelle.

## Admission et identité

La route existante `POST /v1/runs` accepte, après qualification, une unique pièce jointe du propriétaire `audio/mp4`, sans instruction texte jointe et sous admission native owner. Les chemins et MIME viennent de `attachmentContent`, pas du client. Le mémo réutilise la réserve atomique du registre `runs.json`, sa rétention, son verrou et son `requestHash`. Le même `clientRunId` et le même `runId` couvrent transcription puis prise en charge. Le hash initial lie la session et la pièce jointe ; il n'est jamais remplacé par le hash du texte transcrit. Une entrée dupliquée ne relance ni STT ni exécuteur. Aucun nouveau store, routeur, scheduler, service ou daemon.

Après réserve, la réponse est immédiatement `accepted`, `retrySafe:false`, `state:running`. Le statut local expose `status:transcribing` et un message français. Les phases internes `memo.transcribing`, `ready` et `dispatched`, ainsi que l'époque privée du processus propriétaire, sont persistées et relues par le sérialiseur existant. Avant handoff, aucune consultation de session ou transcript Gateway ni correction d'inactivité ne sert à inférer l'état.

## Continuation

`transcribeMemoAttachment` est le seul producteur. Une erreur est projetée en échec français générique ; aucun texte fournisseur brut n'est exposé et le modèle n'est jamais appelé sur cet échec. Le transcript propriétaire est revendiqué une seule fois sous le verrou du registre. La continuation privée appelle le chemin texte existant sans pièce jointe audio : résolution canonique, clarification, capability-first ou Gateway selon leur contrat existant. Elle garde le texte exactement, y compris montants et verbes financiers ; les gardes de paiement existantes décident de la suite. Aucun fichier du module de paiement n'est modifié.

Le dispatch est lui aussi revendiqué durablement avant tout effet. Un redémarrage avant le handoff expose un échec d'interruption et ne relance pas STT. Une revendication d'exécution incertaine ne déclenche jamais de nouveau dispatch. L'époque et le run réservé sont internes : aucun booléen, identifiant de continuation ou token fourni par HTTP n'est accepté.

## Suppression et limites

La suppression de session existante `DELETE /v1/sessions/{id}` retire le run et conserve son identité dans les reçus de suppression existants et bornés. Si elle précède la revendication du transcript ou du dispatch, la continuation est refusée ; un résultat SDK tardif ne recrée pas le run. Une suppression après le début d'un effet ne promet pas d'annuler cet effet. Elle ne remplace pas le propriétaire métier `control_actions` pour une demande déjà créée.

L'annulation de l'enregistrement home avant envoi reste locale à l'app. Il n'existe sur cette base aucun endpoint stop-run ajouté, ni invocation inventée de `chat.abort`. Le SDK STT en cours n'a pas d'AbortSignal public qualifié : supprimer le run empêche sa continuation, sans prétendre arrêter le fournisseur. La rétention des pièces jointes, les délais complets et la lecture SDK du pathname malgré le descripteur ouvert restent à qualifier sur S24 avec Claude.

## Validation et retour arrière

`test-memo-intent-pipeline.cjs`, inscrit dans `ci.yml`, emploie exclusivement des issues SDK/transcripts synthétiques, explicitement distinctes de toute capture S24 : garde produit fermé, réserve concurrente et réponse sous 15 s hors ligne, une STT et un dispatch, hash audio stable, texte financier intact par capability-first, handoff Gateway sans audio, refus d'identité différente, échec STT sans modèle, suppression par la vraie route HTTP, résultat tardif et redémarrage sans rejeu. Les tests existants de runs, suppression et catalogue restent présents et verts en ciblé. Suite CI complète au SHA combiné dans la PR #138, puis recette S24 par Claude.

Retour arrière : revert de cette préparation. Les champs `memo` supplémentaires sont ignorés par les versions précédentes ; aucune migration, aucun nouveau store et aucun déploiement ici.
