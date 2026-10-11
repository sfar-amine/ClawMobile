# Captures S24 du 11/10 (e) : frais Maxit

`maxit-fee-gateway.json` contient les montants nettoyés relevés sur le S24 le 11/10 : le récapitulatif Maxit avant commande (sans frais) et les sessions ClicToPay réelles (5 → 5,700 TND, 10 → 11,400 TND). Aucun numéro, jeton, cookie, identifiant d'ordre ni donnée carte. Le test `scripts/test-maxit-topup-payment-adapter.cjs` vérifie que le total confirmé par biométrie égale ces sessions.
