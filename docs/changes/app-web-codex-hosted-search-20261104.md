# Recherche web de l'app par Codex (04/11/2026)

Décision d'Amine (04/11) : les questions web de l'app passent par Codex seul, sur la carte de recherche existante. Parallel est désactivé, sans repli.

## Ce qui change

- `installer/termux-lite/codex-web-request.mjs` fait un seul appel Gateway `tools.invoke web_search` pour l'agent `main`. Le fournisseur configuré est `codex`, avec le compte OpenAI de Sol et sans clé. L'adaptateur convertit la réponse dans le contrat Web public fermé :
  - chaque paragraphe ou élément de liste devient une affirmation ;
  - chaque affirmation cite les liens que Codex donne ;
  - un paragraphe sans lien cite la liste de sources de la réponse ;
  - `utm_source` est retiré, les liens non publics sont écartés ;
  - au plus 5 sources, 12 affirmations, 1000 caractères par affirmation et 4000 au total.
- `runWeb.ts` (Companion) accepte la variante `provider: codex`, `providerAuth: account`, `profile: openai:codex-hosted-search`, `evidenceType: codex_citation`, sans citation d'extrait. Les autres fournisseurs gardent la preuve par extrait exact.

## Limites

- Codex ne renvoie pas d'extrait de page : l'attribution suit les liens cités par Codex.
- La latence réelle doit tenir dans le budget de 30 s. Elle est mesurée pendant la recette.

## Retour arrière

1. Remettre la politique Parallel/Gemini dans le registre playbooks. Le chemin `parallel-free` n'a pas été modifié.
2. Revert de cette PR.
