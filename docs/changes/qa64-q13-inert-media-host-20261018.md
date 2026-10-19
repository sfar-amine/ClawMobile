# Q13 — préparation du propriétaire host des pièces entrantes

`receiveQaContactMedia` traite les pièces privées dans le propriétaire QA existant. Le module initialement préparé ici est désormais raccordé par `qaContactMediaOwner` au seul hook `message_received` dans cette PR Q13 ; aucun schéma public, route ou déploiement n’est ajouté. Admission, pipe privé et ingestion PB conservent leurs gardes. Aucun transfert réel sur le S24 n’est revendiqué.

## Source qualifiée

Code public installé `openclaw@2026.9.6`, définitions `dist/hook-runner-global-CDmmGFJp.d.ts`, SHA256 `d066e0a30921eb05d79f7ef6b7f425b7e1628b912634b660b13ac324e6bb7c1d`. La fixture `fixtures/qa/message-received-sdk-public-20261018.json` conserve les blocs complets Event/Context/MediaFact, non tronqués, et la provenance du mapper `senderE164`. Ces sources ne sont pas des messages réels d'un contact.

`message_received` est lancé sans attendre sa fin. Il n'expose pas `isGroup`. `before_dispatch` est attendu mais ne reçoit aucun média ; aucune pièce ne lui est inventée. L'admission exige donc le sessionKey canonique direct de la pièce QA, les identifiants Event/Context compatibles, le senderE164 correspondant et la confirmation courante du propriétaire People. L'ordre des hooks ne prouve rien et aucun cache de corrélation n'est créé. Les types, le mapper et le timing sont détaillés dans le relevé public Q13 ; le [commentaire Claude](https://github.com/sfar-amine/samantha-ui-playbooks/pull/196#issuecomment-6250854589) confirme l'absence d'admission média d'un contact aujourd'hui.

## Contrat des propriétaires à raccorder

- `admit(identity, controls)` est une lecture privée : autorité People courante et unique DRAFT **déjà existant** pour l'app explicitement sélectionnée, avec context, run_id, selected_app_id et plan_version entier. Aucun choix, création ou appel à `prepare_contact_turn` implicite. Les callbacks ne sont jamais des champs de requête publique.
- `inboundRoot(admission, controls)` provient du SDK réellement installé. Aucune racine n'est déduite d'une URL, de la requête ou d'une nouvelle variable d'environnement.
- `consume(admission, metadata, content, controls)` transmet les octets au propriétaire `ingest_contact_attachment` PB par le pipe privé borné. Le contenu ne passe ni dans argv, ni dans le Graph, ni dans un modèle. PB revalide l'autorité et utilise le propriétaire `file.put` existant. L'appelant arrête le pipe/processus quand le signal est annulé ; un résultat incertain ne déclenche aucune relance automatique.

Le DTO metadata est fermé : schema_version, transport_event_id, message_id, requester_hash, app_id, name, mime_type, size_bytes, sha256. Le nom est généré, jamais repris du nom privé du fichier. Les identifiants de session/compte/expéditeur demeurent dans l'identité privée et ne deviennent pas un prompt. Les résultats du host contiennent seulement état, cause fixe et décompte réellement importé ; aucune exception, chemin ni contenu brut.

## Garde de lecture

Quatre pièces maximum et20Mio au total, deadline globale10s. Seuls les faits `media` localement prêts sont utilisables ; `originalMedia`, les URLs et le staging en attente n'autorisent aucune lecture ou téléchargement. Chaque fact.messageId doit égaler celui de l'événement. Les formats retenus sont PNG, JPEG, XLSX et texte brut. Audio et PDF restent refusés : l'admission d'un suffixe dans file.put ne démontre pas l'existence d'un parseur PDF canonique.

L'app/DRAFT et l'autorité sont confirmés avant la lecture, puis relus avant chaque pièce et avant sa transmission. Le run, l’app, le contexte de permission, plan_version et dossier_version restent ceux du préflight initial. Un changement, même après une pièce importée, arrête le reste du lot avec son décompte exact ; aucune ancienne approbation n’est recyclée. Le chemin canonique doit être dans la racine inbound du SDK : aucun lien symbolique, chemin extérieur ou lien matériel multiple. Ouverture O_NOFOLLOW/O_NONBLOCK ; fichier régulier, taille bornée, lecture par fragments et vérification inode/dev/taille/timestamps avant/après. Même une ouverture terminée après échéance ferme son descripteur. Les octets copiés sont hachés avant le hop PB. Aucun fichier, état ou registre supplémentaire n'est écrit par ce host.

## Vérification et livraison

Build TypeScript passé et52/52 vérifications ciblées vertes (dont expiration réelle10s) dans `scripts/test-qa-contact-media.cjs`, inscrites au workflow. Elles utilisent des identités et contenus synthétiques, les types SDK publics, de vrais fichiers locaux, symlinks/hardlinks, une limite de volume et une véritable expiration10s. Elles ne qualifient ni un événement réel d'un contact, ni une ingestion ou un accès sur S24. La CI canonique du head exact de la PR core reste requise après intégration.

Retour arrière : retirer le hook média, son adaptateur privé et ses tests ; aucun état existant, média reçu ou campagne n'est supprimé. Le raccord ne peut être déclaré disponible avant recette Q13 et confirmation des interfaces privées propriétaires.

## IPC People privé (même propriétaire)

`whatsappAllowlist.ts` conserve l’unique propriétaire People et factorise son IPC existant. Le repli hérité depuis `__dirname` est remplacé par `runtimeFile("people-trusted.py")`, résolveur F1 ; seule la surcharge de fixture `SAMANTHA_PEOPLE_TRUSTED` est conservée. L’interface publique et les schémas d’outils restent inchangés.

`qaAttachmentOwner` n’accepte que deux modes privés : admission JSON≤16Kio via `qa-attachment-admit`, puis consommation `header{admission,metadata}LF + octets`≤20Mio via `qa-attachment-consume`. Aucune donnée n’entre dans argv. Sortie≤32Kio ; stderr drainé et jamais retransmis ; décodage UTF8 après assemblage des fragments. L’admission lit au plus3s et la consommation utilise le budget restant≤10s. Annulation, échéance, sortie excessive ou erreur de pipe tuent le groupe du processus privé. Après une tentative d’écriture sur le pipe, une issue incertaine est UNKNOWN, sans relance. Les opérations allowlist historiques conservent leurs paramètres et règles d’incertitude.

30/30 vérifications IPC vertes, avec vrai faux propriétaire Python,20Mio bruts, arguments fermés, JSON/volume refusés avant lancement, Unicode fragmenté, sortie excessive/erreur privée et annulation d’un petit-enfant réel. Les tests allowlist existants, paired HTTP→propriétaire Contacts et contact-room sont aussi verts. Aucun appel S24. Le callback Python calcule sa deadline monotonic locale à partir du budget restant : les horloges JS et Python ne sont jamais comparées.
