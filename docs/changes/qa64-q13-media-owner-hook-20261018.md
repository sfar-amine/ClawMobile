# QA64 Q13 — raccord des pièces du tour reçu aux propriétaires privés

Le hook SDK `message_received` réutilise le lecteur `qaContactMediaIngress` et les
modes privés du propriétaire People. Il n'intercepte ni `before_dispatch` ni
`inbound_claim` et ne répond pas sur WhatsApp. Aucun appel modèle, notification,
exécuteur, registre ou stockage supplémentaire n'est créé.

L'identité est uniquement celle du tour direct QA qualifié par le lecteur existant.
Avant toute lecture, `qa-ingress-read` relit les accès et `qa-attachment-admit`
recherche le DRAFT existant avec l'application sélectionnée. Le même contrôle est
répété avant la lecture et avant l'import ; les versions du plan et du dossier
restent liées à la première admission. L'absence ou l'ambiguïté ne crée pas de
campagne. Le budget global est 10 s, quatre pièces et 20 Mio cumulés ; les appels
privés de lecture acceptent maintenant signal/deadline pour respecter ce budget.
Le schéma public de l'outil n'est pas étendu.

La racine n'est jamais fournie par le message ou une variable d'environnement.
Pour chaque ID de fichier attesté dans les media facts, le SDK installé
`resolveMediaBufferPath(id, "inbound")` doit retourner exactement son chemin.
Tous les fichiers doivent partager ce répertoire canonique. Le lecteur existant
vérifie ensuite fichier direct, FD, liens et empreinte. Ni URL, ni originalMedia,
ni média encore en staging ne constituent un repli.

## Preuves et limites

La capture publique du SDK 2026.9.6 est déjà dans
`fixtures/qa/message-received-sdk-public-20261018.json` ; les champs optionnels
absents refusent l'import. Le SDK émet ce hook sans l'attendre : la réussite du
hook n'atteste pas l'achèvement du tour agent. Aucun contenu ni erreur privée
n'est journalisé par le hook.

- `test-qa-contact-media-owner.cjs` : véritable lecteur/FD avec propriétaires
  injectés ; ordre d'admission, révocation, changement de plan, refus de chemin,
  métadonnées, état UNKNOWN et enregistrement réel du hook.
- `test-qa-attachment-owner.cjs` : IPC réel ; délai du contrôle d'accès et arrêt
  du groupe de processus ajoutés aux cas existants.
- `test-qa-contact-media-paired.cjs` : véritable TS → IPC stdin → People Python →
  propriétaires PB `contact_input`, `file.put` et Q2, DRAFT synthétique existant,
  puis révocation refusée sans mutation. `Path.home` est isolé par une fixture
  Python héritée ; HOME du shell reste inchangé. Seuls le SDK de fichiers externe
  et le checkpoint externe de création de la fixture sont remplacés. Aucun
  propriétaire métier n'est simulé. PB est épinglé au commit
  `30026d94b18b4679405fa9c7a08fa7608578b105` (head final Q13 playbooks de la PR212, poussé et épinglé pour la qualification commune).

Les nouveaux scripts sont inscrits dans la CI. Ces fixtures ne prouvent aucun
transfert ni réception sur le S24. L’entrée générique PB est raccordée dans la PR212 avec les gardes privées et les phases automatiques. Les recettes physiques restent à effectuer après revue. Aucune activation ou déploiement n'a été effectué.
Un import peut modifier le plan : les pièces suivantes sont alors arrêtées par
la liaison de version ; le compte des pièces effectivement importées est conservé.

## Retour arrière

Retirer l'enregistrement `message_received` ; les propriétaires privés demeurent
inaccessibles depuis le schéma public. Aucun effet envoyé n'a besoin d'être annulé.
