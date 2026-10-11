# Voix comprise — V1/V2/V3 consolidés

La présentation et la décision HS3 fusionnées sont l'unique source : `readReceiptPresentation` et `publicDecision`. Les champs `selected`, `skill_plan`, devis et paramètres bruts ne recréent ni compréhension ni décision. La confiance conservée dans la décision ou le harness fixe le seuil 0,6 ; les transactions et CLARIFY sont annoncés. Les alternatives proviennent de HS3, sinon de la shortlist du même tour.

Le propriétaire de clarification E3 reste `SurfaceClarifications`. Il transporte les métadonnées HS3 publiques sans exposer le résultat privé. `clawLiveCapabilityTurn` garde question, clarificationId de session et originId ; `clawLiveCapability` ajoute compréhension/réalignement autour de cet exécuteur avec une unique admission warm. Le relais conserve clarification et continuation canoniques, et prononce un échec sans passage à l'agent.

Les gestes FR/EN/derja/arabizi sont ceux de `voice-realign-v1-20261011`, fenêtre 120 secondes en mémoire, sans transcript persisté. La capture utilise `skill_intelligence.improvement capture-round --surface voice`. Les formes derja/arabizi restent authored_pending_amine jusqu'à la recette live.

La protection des OTP/PIN explicitement désignés courts est fournie par #137 au lecteur partagé. #150 intègre cette branche par merge et vise runtime ; Claude fusionne #137 avant #150. Aucune implémentation V1/V2/V3 parallèle n'est conservée dans #137.

« Rien n'a été débité » exige la preuve propriétaire payment_not_submitted et aucune preuve de soumission contradictoire. Un statut blocked ne prouve rien : capture Topnet réelle après financial_dispatch_committed. Le parcours de paiement n'est jamais modifié. La transaction s'arrête sur la confirmation native, la parole exacte et son ordre restant à qualifier sur S24 par Claude avec Amine.

Tests : script `test-voice-understanding.cjs` inscrit dans CI, captures #129/#131 et présentations #127 déjà fusionnées, mutations de contrat explicitement synthétiques. Les budgets de projection restent des mesures locales ; recette Live/relais avec latence et voiceVerbatim.spoken à relever sur S24. Retour arrière : revert, aucun store ou migration.

Capture #176 : JSON et README copiés byte-identiques depuis f036943cc63af9401e7d5e242ba3b379d61056ea ; SHA-256 du JSON 889bda40ada634220b0af24d792efc46b948565367f4a59fd334cefacb4f970a. Deux chaînes liées gardent un run done/info malgré un paiement blocked après financial_dispatch_committed. La trace/timeline canonique de soumission interdit une assurance de non-débit même si le booléen est absent ou incohérent. Les décisions masquées ne sont jamais décodées ni utilisées pour exécuter ; la capture qualifie cette preuve négative, pas la compréhension ni le transport audio.

Les preuves publiques d'enveloppe, execution, result et payment sont également examinées. Un booléen de soumission présent mais malformé, une trace/timeline présente non tabulaire, un événement sans stage textuel ou plus de 160 événements interdit toute assurance de non-débit ; aucune forme privée ou source supplémentaire n'est consultée.
