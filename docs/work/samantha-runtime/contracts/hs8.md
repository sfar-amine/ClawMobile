# HS8 — Mémo Gemini et reprise différée dans les runs

## Périmètre et activation

Le fichier 46 de la passation est applicable : transcription par **Gemini `gemini-3.5-flash-lite`**, profil gratuit existant `google:claw-gemini-free`, sans OpenAI. Le repli est un nouvel essai Gemini différé. Aucun compte, modèle de remplacement, secret, configuration globale ou service n'est créé.

La préparation est intégrable sous le garde fermé `MEMO_STT_QUALIFICATION`. Upload audio, transcription produit et `catalog.inputs.voiceMemo` restent refusés. Une suite locale verte atteste le code préparatoire ; elle ne constitue ni activation, ni recette Android, ni déploiement.

## Sources réelles et portée des preuves

Les captures nettoyées Claude sont conservées byte-identiques :

- core #185, commit `320bf82b95a06499dcc7a3f588fd2a32efee0922`, `fixtures/s24-2026-10-11/hs8-v2/` : import SDK public installé sans NODE_PATH, disponibilité du profil gratuit, clé Google concurrente, état du recorder installé et propositions de retry ;
- core #174, commit `e55788f3bde0975e8bad505719559df3e451a76e`, `fixtures/s24-2026-10-11/hs8-captures/` : M4A synthétique neutre, SHA256 `45b72fe4f79215f6ab6f4366239a79117330f355cc2bf17f745bce29b929c826`, 12 967 octets. Gemini 3.5 flash-lite le transcrit en 1 486 ms. Ce fichier ne provient pas du recorder Android ;
- captures antérieures #170 et découverte SDK : historique de résolution et des formats, conservé dans `fixtures/s24-2026-10-11/hs8/`.

#185 atteste `tools.media.models=[]`, le profil verrouillé et une **autre** clé via `models.providers.google.apiKey`. Le contrôle d'auth demeure fermé sur cette collision. Amine décide de l'alignement ou du retrait de cette clé ; Codex ne le fait pas. La permission micro Termux:API était refusée et le recorder Android installé absent lors de la capture. Le code recorder Android existant est traité dans le lot app ; sa présence dans Git ne vaut pas enregistrement réel. `mp42`/`isom` sont des marques attendues AOSP, sans capture Android qualifiée à cette date.

## Propriétaire SDK et transcription

`memoSttOwner.ts` réutilise les exports publics OpenClaw **2026.9.6** `loadConfig`, `runMediaUnderstandingFile` et `resolveApiKeyForProvider`. Résolution locale en priorité ; paquet local partiel ou incompatible refusé. En absence locale seulement, `npm root -g` sans shell ni installation est borné à 3 s / 4 Kio, puis les exports publics du même paquet/version sont importés en ESM. Aucun chemin interne de secours ni changement de NODE_PATH.

La projection par requête utilise le modèle exact qualifié et le profil gratuit existant ; elle tolère le tableau média vide attesté mais respecte une désactivation explicite. Elle ne persiste rien. Un modèle audio existant exact est réutilisé ; aucun autre fournisseur n'est essayé. La prévalidation SDK utilise `lockedProfile:true` et vérifie seulement les métadonnées de profil/mode. Valeurs de clés non copiées, non réinjectées et non journalisées. Les surfaces concurrentes d'auth Google — clé provider, environnement et noms d'en-têtes d'auth dans les couches provider/audio/entrée — sont refusées ; les en-têtes de transport ordinaires restent intacts. Ce refus n'est pas une décision de changer la configuration S24.

Prompt verbatim dans la langue d'origine ; la derja est demandée en arabizi. Aucun résumé, traduction, réponse ou exécution de consignes audio. Le texte accepté est transmis intact au propriétaire de résolution, puis au parcours canonique sans pièce jointe audio. Aucune modification des gardes paiement : une transcription financière conserve la classification et la frontière biométrique canoniques.

Plafonds de préparation : minimum des limites locales/entrée/audio, au plus 10 Mio et 60 s par entrée. Le résultat entier est refusé au-delà de 12 000 unités UTF-16 ou 48 Kio UTF-8, jamais tronqué ; `maxChars` SDK retiré pour éviter la troncature d'une instruction. Le délai global SDK avec retries internes et l'arrêt effectif du fournisseur ne sont pas attestés par ces plafonds.

## Audio, conservation et suppression

Le propriétaire existant `attachmentStorage` accepte `audio/mp4` sous le même garde fermé. Le parseur ISO-BMFF borné (1 024 boîtes, profondeur 4) exige une marque `M4A `, `mp42` ou `isom` **et** un handler `soun` dans `moov/trak/mdia/hdlr`. Vidéo seule, marque seule, chaîne `soun` dans le payload, tailles malformées et dépassement de borne sont refusés. Cela prouve une piste déclarée audio, pas le codec AAC décodable ni la qualité d'une vraie capture Android.

Les plafonds existants restent : fichier 10 Mio, quota 500 Mio, 10 000 fichiers ; durée de rétention 30 jours à partir du mtime propriétaire. Les dates d'expiration sont obtenues du fichier ouvert côté serveur, jamais confiées au HTTP, et ajoutées uniquement aux pièces audio pour préserver les hashes historiques des autres fichiers.

L'audio reste référencé pendant l'attente STT et la phase prête à poursuivre. Après claim de continuation autorisé, le run conserve son identité et son hash original, supprime la référence audio puis le fichier s'il n'est pas partagé. Une annulation de session supprime également le fichier non partagé. L'expiration issue du propriétaire clôt le run sans transcription ni effet et libère le fichier lors des lectures/du nettoyage existant. Les autres références vivantes sont protégées. Le SDK relit un pathname : le descripteur ouvert ne constitue pas une preuve contre toute substitution concurrente. Cette frontière et les délais de nettoyage doivent encore être mesurés en recette.

## Retry et identité dans le registre existant

Aucun scheduler, store, route ou registre supplémentaire. `StoredRun.memo` est persisté par le propriétaire RUNS existant, sous son verrou, avec l'identité originale `clientRunId/sessionId/runId`, le hash de soumission original et l'identifiant audio. Les états internes sont `transcribing`, `transcription_pending`, `ready`, `dispatched`.

Politique de préparation, issue de la proposition de #185 et non d'une mesure runtime : **trois tentatives maximum**, reprise après **2 minutes**, puis **10 minutes**. La lecture GET du statut ou par clientRunId peut réclamer atomiquement une tentative arrivée à échéance ; elle n'exécute aucune commande. Douze lectures concurrentes ne créent qu'une tentative. Un redémarrage reprogramme une tentative interrompue ; après le troisième essai interrompu, le run devient `failed`, sans attente perpétuelle ni quatrième appel. Échec fournisseur terminal : erreur publique générique, aucun détail d'auth ni payload audio.

Projection publique :

| Situation | `state` / `status` | `memoTranscription` |
|---|---|---|
| STT active | `running` / `transcribing` | `{phase:"transcribing",attempts}` |
| Réessai futur | `running` / `transcription_pending` | `{phase:"transcription_pending",attempts,nextAttemptAt}` ; échéance epoch millisecondes |
| Texte prêt | `running` / `memo_ready_to_continue` | `{phase:"ready",attempts}` |
| Trois essais épuisés | `failed` | phase pending, sans nouvelle échéance |

Les messages français annoncent attente ou disponibilité sans exposer la transcription dans le message de statut. Les références publiques existantes des pièces audio permettent la reprise ; aucun pathname/jeton d'admission n'est publié.

## Admission native fraîche et continuation

L'admission P1 demeure son propriétaire `ownerTurnAdmission` (PR #182). Sa tête stable `2810820472c1a2274c0628c3139ba038672e31d3` est intégrée par merge normal comme dépendance. Le propriétaire HTTP vérifie une seule fois le corps signé et transmet le même ticket opaque ; la continuation ne consomme pas un deuxième nonce. HS8 ne fabrique aucun ticket, grant durable ni autorité depuis GET. Son absence dans l'installation ferme la soumission audio. La première requête audio vérifie le corps HTTP exact, puis garde le ticket opaque seulement en mémoire ; `isCurrent` est vérifié avant résolution, claim et remise à l'exécuteur.

Un succès après retry différé reste **prêt à poursuivre** : GET n'a pas de ticket natif frais et n'exécute rien. L'app active peut tenter une fois une nouvelle admission native signée ; en cas de refus ou de conversation inactive, elle présente la poursuite explicite. Aucun auto-POST en boucle ni ticket sauvegardé. Corps du POST `/runs` existant : mêmes `clientRunId` et `sessionId`, instruction vide, `displayText:"Mémo vocal"`, référence audio originale `{id,displayName}`. Pas de champ trusted, de transcript client, de réupload ou de nouvel identifiant.

Le serveur retrouve le run existant, utilise son texte propriétaire et réclame atomiquement sa continuation avec admission actuelle. Révocation ou expiration pendant la résolution laisse le mémo prêt sans effet. Annulation/tombstone l'emporte. La continuation retire l'audio avant l'exécuteur canonique et conserve le même run ; le fast path financier reste inchangé. Si une réponse POST est perdue après nettoyage audio, le propriétaire app rapproche le reçu via GET par clientRunId ; il ne crée pas de second run. Une simple répétition HTTP avec référence déjà supprimée peut recevoir 404 et n'est pas présentée comme un réupload permis.

## Validation, budget et recette restante

Les tests CI inscrits couvrent la projection SDK, les captures 174/185, le parseur borné, la résolution publique synthétique, la continuation canonique, concurrence/retry/redémarrage/cancel/partage/expiration/révocation et l'absence d'effet fournisseur en refus. Les tickets des tests unitaires de pipeline sont un seam opaque hors ligne. Le test de composition HTTP `test-memo-p1-http.cjs` utilise également le propriétaire P1 réel, de vraies signatures P256 et son cache de nonces, avec enrôlement préalable isolé ; l’enrôlement biométrique et la matrice cryptographique complète demeurent testés par la suite P1 intégrée. Ces tests ne qualifient pas le raccord SDK installé ni un recorder Android réel. Aucun appel fournisseur live effectué par Codex.

Les routes existantes POST `/runs`, GET `/runs/:id`, GET `/runs/by-client/:id` et DELETE `/sessions/:id` restent les seules routes concernées. POST accepte le travail asynchrone dans le budget existant inférieur à 15 s ; les lectures réclament le retry sans attendre STT. La mesure réelle S24 de ces routes et du temps STT total reste requise. La suite entière est rejouée au SHA exact avant publication ; son N/N et son reçu sont dans la PR, distincts des anciennes preuves historiques.

Avant activation : vraie capture AAC/M4A du recorder Android (marque, piste, durée, taille, SHA), décision Amine sur la clé Google concurrente et/ou permission Termux, import/config/profil exact dans Companion installé, réadmission P1 actuelle et révocation, succès/échecs/retry terminal, budgets cumulés, rétention/suppression et confidentialité des journaux. Claude réalise la recette et le déploiement autorisé. Retour arrière : retirer cette préparation, garder le catalogue fermé ; aucune configuration runtime n'a été modifiée par Codex.
