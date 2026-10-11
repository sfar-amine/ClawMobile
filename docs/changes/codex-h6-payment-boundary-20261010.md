# H6 — intention résolue et vocabulaire libre

Remplace les refus fondés sur des mots par la décision canonique checkOnly.
Une lecture peut mentionner paiement, recharge ou un montant ; une transaction
sans ces mots reste protégée. Les secrets et confirmations humaines conservent
leurs gardes. [Contrat H6](../work/samantha-runtime/contracts/h6.md).

Préparation de source : les validations locales complètes et la recette S24
restent à effectuer avant livraison.

Revue source : confirmations et frontières humaines imbriquées agrégées, contradictions protégées, snapshots/types invalides refusés. Matrice préparée ; aucune suite de cette nouvelle tête encore exécutée.

Validation locale du 11/10 : build et cinq suites owner/intention/inactivity verts sur 839f7306 ; la suite fichiers a révélé la catégorie de nom OTP perdue, corrigée avec catégories de confidentialité OTP/CVV/CVC bornées. Rebuild et suite fichiers verts après correction. Six suites ciblées vertes, suite CI entière à exécuter au commit documenté final ; aucune qualification S24 ni ready revendiquée ici.

Première suite entière 8f37ad59 : 65/67, deux contrats anciens notifications/approvals. Extension owner approvals : trois filtres de mots financiers supprimés, décision canonique et whitelist exec inerte/liaisons paiement/confirmations gardées, confidentialité OTP/CVV/CVC conservée. Build et deux suites corrigées verts : lectures avec bank/invoice/montant autorisées, transaction sans mots financiers/inconnu refusés avant RPC, risk client rejeté. Nouveau passage intégral exigé au SHA final ; captures S24 toujours Claude.
