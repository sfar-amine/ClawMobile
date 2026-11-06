# Paiement SONEDE dans le Companion, éteint par défaut (06/11/2026)

**Constat.** Le Companion déclarait SONEDE en `provider_payment_contract_unverified`, sans adaptateur. La PR playbooks jumelle ajoute l'adaptateur fournisseur SONEDE sur la passerelle ClicToPay partagée. Le portail SONEDE a été relevé en vrai le 06/11, sans carte ni paiement.

**Changement.**
- `sonedeLivePaymentAdapter.ts` : SONEDE passe par la fabrique ClicToPay existante :
  - références à chiffres seulement (`idBase` SONEDE) ;
  - origines bancaires : `3ds2.clictopay.com`, `ipay.clictopay.com` et `portail.sonede.com.tn` ;
  - reçu interne `internal-sonede-…`.
- **Éteint par défaut.** Le chemin propriétaire (biométrie) est proposé et exécutable seulement quand le marqueur `clawmobile-companion/sonede-live-acceptance.enabled` contient exactement `sonede-v1-live-acceptance`.
  - Ce marqueur est lu en direct, et chaque démarrage le consomme (nouvelle option `localRequiresGate` de la fabrique).
  - Sans marqueur, la réponse est `blocked / payment_not_submitted` : rien n'est envoyé, ni carte ni passerelle.
  - La reprise du même paiement (retour bancaire, réconciliation) n'a pas besoin du marqueur.
- Catalogue : la preuve de porte `sonede` est projetée seulement si le marqueur est armé.
- Topnet est inchangé : chemin propriétaire constant, consommation de porte inchangée. STEG reste non vérifié.

**Recette.** À faire avec Amine sur une vraie facture. Le marqueur est posé juste avant, et un seul paiement est possible par marqueur.

**Retour arrière :** revert, puis redéploiement du Companion précédent.
