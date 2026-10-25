# L5 — modèles par flux (Core)

R6/R21 étendus sous porte L3 ; onze flux réels, trois cibles modifiables. Le contrat de préservation des sessions refuse explicitement avant qualification SDK, donc cette source ne constitue pas une activation. Voir [propriétaires, fixtures, limites et recette](../work/samantha-refonte/L5-model-flows-owner.md).

Fixtures S24 avant code, policy canonique épinglée698322f7 et Core d87bd249. Mutations testées localement par mocks explicitement rédigés. Contrats de coût inclus, biométrie sur nouveau primaire/compte, CAS, reçu scoped/rétablissement exact et isolement des contacts. Aucun nouveau store ou outil. R6 déjà NO_CAPABILITY ; primitives MCP inchangées.

Validation ciblée hors téléphone : npm ci, build TS et trois suites model-flows/model-roles/agent-config PASS. Premier build L4 timers et première reconstruction de capture compaction corrigés par leurs propriétaires ; logs v1 conservés. CI canonique et recette native restent requises ; aucun merge ni déploiement. Retour arrière par le propriétaire Companion et la compat SDK versionnée.

Pile source sur PR425 (L4), propriétaire readModelFlowTurnLatency réutilisé pour les seules métriques attribuables. Le statut du même run rapproche un effet configuration incertain par readback sans jamais redispatcher config.patch. Le catalogue de conversation prioritaire conserve lui aussi la politique de coût inclus sous porte cerveau unique.

Provenance R6 : les réglages L5 n’utilisent plus SAMANTHA_BRAIN_ONLY. Le même config.patch/CAS écrit modelFlowSelection version1, avec une entrée par flux contenant le hash canonique des champs possédés. L’absence est neutre, un hash invalide refuse. Le reçu conserve présence/absence de cette entrée ; revenir à un flux ne supprime pas l’admission d’un autre. Un marqueur vide est retiré. Les valeurs de modèles restent uniquement dans leurs propriétaires natifs existants, sans copie de catalogue. Les sessions déjà épinglées gardent leurs valeurs ; un nouveau premier tour n’est profilé que sur provenance admise. Cette nouvelle union et ses tests nécessitent le ciblé/CI final, non couverts par les anciens logs v2.
