# Claw MCP V1 — checkpoint de livraison bloque

Date : 5 octobre 2026. Claude reste le premier client a raccorder. Aucun autre client active.

## Etat verifie
Candidats isoles conserves. Aucun commit de ce lot publie vers la branche de production ; aucun deploiement ou raccordement Claude realise. Le relais live reste connected/authenticated. La surface external_mcp et le module mcpBridge sont absents du runtime canonique.

## Modifications et preuves du tour
La garde read-only est placee dans CapabilityGraph.execute, sur la resolution exacte qui va etre executee. Le helper et capabilityBridge transmettent le flag. Le parcours MCP n'effectue plus deux resolutions susceptibles de diverger. Les tests de garde/routage/registre passent : 56 tests. Les tests du protocole edge passent. Le build TypeScript final passe apres archivage hors build des brouillons OAuth/context non raccordes. Ces preuves ne constituent pas une recette Claude.

## Blocages explicites
1. Ecriture de remplacement de mcpBridge.ts refusee par le controle externe OpenAI avant application. Ping RDC, readback et commande de lecture simple reussissent. Incident f376015263d4004361ba traite et failed, rattache a claw-mcp-gateway-v1-20261005. Aucune reparation locale en cours, aucun rejeu de la mutation refusee ni changement de transport pour la contourner.
2. Les headers statiques de Claude sont documentes comme une beta reservee a certaines organisations. Le prototype Bearer ne valide donc pas Claude Pro ; OAuth reste a raccorder puis recetter avec le vrai compte. Source : https://claude.com/docs/connectors/building/authentication (consultee le 5 octobre 2026).
3. Restent a finaliser et recetter les identites d'action non ambigues, la distinction entre completion du transport et resultat metier, le filtrage des artefacts et le comportement de reconnexion. Ne pas exposer ce candidat sur Internet dans son etat actuel.
4. L'ecart de couverture device.laptop_termux_access du graphe de dependances etait deja reproduit sur main. Ne pas declarer toute la regression PASS.

## Reprise
Conserver les identites taskId/stepId et les preuves ; ne pas repartir du debut. Reprendre le raccordement uniquement apres resolution de la frontiere externe. Puis tests complets, publication, activation runtime, recette reelle Claude et cleanup. Les brouillons sont des travaux non integres, pas une solution de contournement a executer.

## Preuves locales
~/.openclaw/backups/claw-mcp-gateway-v1-20261005/closure-evidence/
results.json ; readonly-and-graph.log ; edge-protocol.log ; typescript-build-final.log ; final-runtime-observation.json.
