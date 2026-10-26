# Provenance du diagnostic de préparation

Deux programmes **publics** complets du SDK2026.9.6, compressés gzip déterministe,
sont byte-identiques aux modules non symlinkés relus sur le S24 avant modification.
`provenance.json` conserve les SHA256 du tar, des programmes et des reçus nettoyés.
Aucun journal brut privé, configuration, auth, demande/réponse ou transcript n'est
copié ici. `native-timings.json` conserve exclusivement métadonnées et nombres.

Le run public unique réussit avec0tool/1round modèle. Le span plugin-tools vaut
11154ms ; les53factories totalisent16ms. Ce constat situe le coût avant les
factories mais ne prouve ni cache miss, ni loader froid, ni lookup précis. Le
system-prompt coûte3496ms séparément. Les checkpoints et spans peuvent se recouvrir.

Le patch ajoute des checkpoints à `recordToolPrepStage`, déjà détenu par le SDK.
Les tests exécutent les fonctions exactes originales/patched avec propriétaires
inertes et comparent effets, retours, exceptions et bornes. Aucun modèle ni outil
réel n'est invoqué. Les modules changent uniquement par le propriétaire existant
de compatibilité hashé ; retour arrière vers les octets publics exacts.
