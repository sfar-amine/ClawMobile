# HS8 — continuation du mémo dans le propriétaire des runs

Complète le [contrat SDK HS8](hs8.md), réaligné sur la passation46. `MEMO_STT_QUALIFICATION` reste fermé : admission audio et `inputs.voiceMemo` ne sont pas activés. Le modèle qualifié est Gemini3.5flashlite sur le profil gratuit ; aucun repli OpenAI. Une preuve CI locale ne qualifie pas le recorder Android ni le runtime S24.

## Admission et identité

Après qualification, POST `/v1/runs` accepte une seule pièce propriétaire `audio/mp4`, instruction vide, admission native P1 signée fraîche. Une seule `verifyRequest` HTTP vérifie le corps brut ; le même ticket opaque est passé au propriétaire d'intention puis vérifié par `isCurrent` devant les claims/effets. Aucun ticket sérialisé, grant durable ou champ trusted HTTP. P1 stable28108204 est intégré comme dépendance par merge normal ; absence d'admission actuelle refuse le mémo.

Le propriétaire `attachmentContent` fournit MIME, chemin, taille et dates d'expiration. Le registre RUNS, son verrou et son hash initial lient session et audio ; même `clientRunId/runId` pour STT et continuation. Le hash initial n'est pas remplacé par celui du texte. Réponse immédiatement acceptée/asynchrone dans le budget existant<15s ; aucun appel fournisseur attend son résultat dans POST/GET.

## Retry différé et continuation

`transcribeMemoAttachment` est le seul producteur. Politique de préparation : trois essais maximum, nouveaux essais après2/10 minutes, Gemini seul. Le registre persisté porte phase/attempts/deadline et époque du processus ; GETstatut/GETparclient revendiquent une seule tentative due sous verrou. Douze lectures concurrentes produisent un appel ; un redémarrage diffère l'essai interrompu. Après le troisième essai interrompu ou refusé, état failed sans quatrième appel ni attente perpétuelle. Ces délais sont une politique, pas une mesure capturée.

GET fait STT uniquement. Un succès différé demeure running/status `memo_ready_to_continue`, phase `ready`, avec référence audio originale. L'app active peut tenter une admission native fraîche une fois ; refus/inactivité demande une poursuite explicite et empêche toute boucle auto. POST existant avec instruction vide, même session/clientRunId et référence audio originale reprend le texte propriétaire ; aucun transcript/flag de continuation client accepté, pas de réupload ou nouvel identifiant.

Le texte accepté est transmis intact sans audio à la résolution canonique, puis clarification/capability-first/Gateway selon leurs propriétaires. Montants et verbes financiers ne sont pas retirés ; aucun fichier paiement déterministe modifié. La phase `dispatched` est réclamée atomiquement avec ticket actuel avant effet. Révocation/expiration pendant résolution conserve ready sans effet ; après claim, une révocation refuse la remise non commencée. Un effet déjà remis ne peut pas être annulé par une simple suppression ni rejoué.

## Conservation, suppression et limites

L'audio est retenu jusqu'au claim de dispatch autorisé ou jusqu'à annulation/expiration issue de sa source. Après claim, référence supprimée et fichier retiré s'il n'est pas partagé. DELETEsession conserve les tombstones existants ; cancel gagne contre résultat SDK tardif et retry. L'expiration du propriétaire (mtime+30jours) clôt le run et libère l'audio. Aucun nouveau store, route, scheduler ou worker. Quota/fichier/rétention du propriétaire existant conservés ; details dans hs8.md.

Si une réponse POST est perdue après suppression de l'audio, le propriétaire app rapproche le run par GETclientRunId ; pas de nouveau run/réupload. Une répétition HTTP référençant le fichier supprimé peut répondre404. Annulation locale du recorder reste dans l'app. Aucun stop-run ou chat.abort inventé ; le SDK relit un pathname et ne fournit pas ici un AbortSignal global qualifié. La suppression bloque la continuation, sans promettre l'arrêt du fournisseur.

## Validation et retour arrière

CI conserve pipeline, retry différé, projection SDK, résolution publique et HTTPattachments. Le nouveau test HTTPP1 emploie signatures P256 réelles, propriétaire d'admission réel et cache de nonces : preuve validée une fois, replay refusé, GETsans ticket, révocation/forgery refusées, continuation fraîche même run. La matrice P1 intégrée couvre54cas. Enrôlement préalable/SDK fournisseur contrôlés hors ligne, pas recette S24. Les autres tests couvrent hash stable, concurrence, texte financier intact, Gateway sans audio, partage/cancel/expiration et troisième essai après redémarrage.

Suite entière locale sur SHA exact dans PR138 avant readiness ; recette Android/profil/délais/privacy encore nécessaire avant activation. Retour arrière par retrait de la préparation et maintien du garde fermé ; aucune migration ou configuration runtime modifiée par Codex.
