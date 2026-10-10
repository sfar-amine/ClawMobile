# C6 — transmettre les scopes et l'identité de surface

Le pont utilise l'identité admise du relais pour la provenance du contexte et transmet les scopes techniques au lecteur propriétaire. Les arguments client ne peuvent pas choisir un profil ou une surface. Le manifeste épinglé garde l'unique liste des scopes ; aucun catalogue ou store ajouté.

Schema MCP, transport et régressions sont testés en CI ; la fixture réelle contient seulement métadonnées d'accès/manifeste. Jumelle playbooks nécessaire pour les surfaces et le refus d'un manifeste manquant. Aucune activation effectuée ; contrat `docs/work/samantha-runtime/contracts/c6.md`.
