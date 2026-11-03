# ADR — modèles par flux et préservation native des sessions

Statut : décision d’architecture de source, qualification SDK et recette S24 en attente. Mandat utilisateur parcours unique du 25/10 ; porte L3 conservée.

R6/R21 restent propriétaires de l’écriture et de la projection des modèles. La priorité est conversation > flux > défaut Samantha. Un changement de flux ne doit modifier ni modèle/effort/vitesse des sessions déjà commencées, ni l’identité, les outils, la mémoire ou les droits des contacts.

Le propriétaire de persistance SDK confirmé sur OpenClaw 2026.9.6 est SessionEntryCore.pluginExtensions, déclaré par api.session.state.registerSessionExtension et modifié par le propriétaire natif session-store-runtime.patchSessionEntry. Aucun store, namespace openKeyedStore ou sessions.pluginState n’est inventé. L’extension validée et datée par sessionId/lifecycle reçoit le profil complet. Le hook awaited existant doit le consommer avant la préparation du premier candidat et des secours, puis avant auth/effort/vitesse. Un hook détaché session_start ou un champ jamais lu par le SDK ne qualifie pas cette garantie.

La mutation R6 réserve le run/checkpoint dans le ledger existant avant préservation ; les premières sélections non épinglées consultent cette activité. Une préparation interrompue ou un effet indéterminé reste clôturé à l’admission jusqu’à preuve. Le statut du même run peut rapprocher un effet configuration par readback, sans redispatcher la mutation. Aucune file, minuterie, worker ou moteur de retry parallèle n’est introduit.

Le même GET peut terminer un checkpoint `dispatching` encore projeté `running`, après attestation de préservation, correspondance de la provenance ledger run/flux/operationId et readback exact. Ce constat ne suppose pas la mort d’un ancien processus. Un `prepared` seul, un propriétaire non attesté ou un hash non concordant conserve la barrière ; aucun effet n’est rejoué pour combler une preuve manquante.

La compatibilité étend uniquement le propriétaire OpenClaw existant, avec version/package et SHA complets des modules publics capturés, remplacements exacts, tests de leurs consommateurs, check/apply/rollback atomiques et parité runtime-sync. Aucune installation S24 avant CI canonique et activation du responsable. L’adaptateur natif est joint à cette source avec le consommateur et les contrats capturés ; une absence du contrat apparié en runtime reste refusée. La CI canonique et la recette S24 demeurent requises avant activation et clôture.

Le résumé utilise uniquement compaction.model. Sans override, le SDK emploie le modèle courant de chaque conversation : le défaut global ne permet pas d’inférer sa valeur. La préservation model-only inclut ce cas null/hérité et respecte les verrous de harnais/preflight natif. Aucun effort, vitesse ou secours imaginaire n’est ajouté au schéma natif de compaction.

Les seuls modèles proposés sont permis, disponibles, authentifiés et couverts par politique canonique d’abonnement inclus ou couple exact gratuit ; une disponibilité API ne prouve pas la gratuité. Les profils restent opaques dans les reçus et l’app. Nouveau fournisseur ou compte implique la confirmation biométrique existante, même pour le primaire.

Conséquences : app et Companion doivent être appariés, SDK source joint et qualifié avant nouvelle sélection en production. Retour arrière par les propriétaires Companion/APK et rollback SDK versionné ; aucun effacement de sessions, configuration privée, auth ou reçu. Les mesures nulles restent inconnues ; les seules latences WA attribuées proviennent du propriétaire L4.

Provenance durable : modelFlowSelection version1 dans la config du plugin, avec flows.<cible> = {version:1,fieldsHash}. Les paths et le hash proviennent du même ModelOwner que R6 ; le SDK utilise verifiedModelFlowProvenance(config,flow), jamais le client, un flag d’environnement ou l’historique borné du ledger. Le reçu rétablit l’entrée de preuve et les champs possédés. Une métadonnée d’un autre flux est préservée. Le journal de run sert seulement de barrière pendant le CAS, pas de source permanente d’activation.
