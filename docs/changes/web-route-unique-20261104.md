# Route web unique (04/11/2026)

**Constat S24 du 04/11.** « Quel est le prix du Brent aujourd'hui ? » a pris 92 s par le cerveau principal :
- `tool_search` pour trouver l'outil web : 7 s ;
- puis trois `web_search` à la suite pour recouper : 21 s, 27 s et 25 s.

La route dédiée `public_web` répond en 19 s avec une seule recherche Codex.

**Changement (core) :**
- **`samantha_web` toujours visible du cerveau.** C'est l'outil typé qui porte `samantha.app.web.answer|search` (projeté par samantha-ui-playbooks). Sa description demande une seule action par question.
- **Plafond du helper typé à 45 s** pour ces actions, afin que la recherche web (30 s de budget) ne soit pas coupée par le plafond générique de 30 s.
- **`web_search` brut refusé à l'agent `main`.** L'adaptateur Codex appelle désormais `web_search` sous la politique de l'agent `contacts`, qui l'autorise (vérifié en réel le 04/11 : 17,8 s).

**Activation :** avec la PR playbooks qui projette `samantha_web`. Sans elle, le cerveau n'aurait plus d'outil web.

**Retour arrière :** revert, puis redéploiement.
