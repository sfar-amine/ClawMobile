# Accès propriétaire ChatGPT par nouveau consentement OAuth

Décision directe d’Amine, chat Codex du 23/10/2026 : « je te donne carte blanche
pour ouvrir tout ça », après sa demande de supprimer les approbations techniques
répétées. Les permissions ChatGPT des connecteurs Samantha et GitHub ont été
changées en `full_access` par l’outil de permissions, qui a confirmé les deux
opérations. Ce réglage ne change ni le sandbox des commandes Cloud, ni un grant
OAuth existant. L’autorisation couvre ce changement technique, ses tests,
intégration, publication et activation ; elle ne remplace aucune frontière
humaine des parcours métier.

Le propriétaire OAuth existant accepte un nouveau choix `owner` sur la page de
consentement liée au navigateur. Le choix par défaut reste la lecture. Après
validation Google de l’unique propriétaire, l’AS émet `mcp:read` et `mcp:owner`,
avec `access=owner` et `ownerConsentVersion=1` dans ses propriétés signées.
Le Resource Server exige simultanément portée et propriété de consentement
pour exposer `chat-owner`. Un désaccord est refusé. L’ancien grant de lecture
reste `chat-owner-shadow`, y compris lors d’une reprise de transaction ancienne.

La librairie OAuth existante définit explicitement que `approveConsent` peut
approuver moins ou plus de portées que celles demandées, à condition qu’elles
soient supportées et que l’utilisateur les ait choisies. La page expose donc
clairement les commandes techniques et les actions déjà autorisées par Claw.
Les données de callback ne choisissent aucun droit : seul le grant conservé
par l’AS dans la transaction serveur fait foi.

Même Worker AS, même KV, même binding RPC, même client `chatgpt`, même Gateway,
mêmes profils et six primitives. Aucun jeton Claude/Codex n’est réutilisé ou
copié. Aucun secret, profil bancaire, modèle métier ou service S24 n’est changé.
Les consentements, PKCE, nonce, audience, expiration et vérification Google
existants restent en place. Aucune ancienne connexion n’est silencieusement
convertie en propriétaire.

L’installation exige la CI canonique hors S24 et la publication des deux Workers
par Wrangler, AS puis relay, avec versions et rollback conservés. Les anciens
clients de lecture et les clients Bearer existants restent utilisables pendant
cette mise à jour. Une reconnexion Samantha avec choix propriétaire sera ensuite
nécessaire pour qualifier le véritable OAuth ChatGPT ; un test Workerd local ne
remplace pas cette preuve. Le retour arrière retire d’abord le Resource Server
modifié, puis l’AS si nécessaire ; il conserve KV et reçus et ne rejoue rien.
