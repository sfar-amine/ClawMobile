# Voix : une réponse du cerveau n'est plus perdue quand Gemini clôt une génération silencieuse

Le 7 novembre 2026, pendant la recette vocale, trois réponses sont restées muettes : « active le mode ne pas déranger », « mets un minuteur de deux minutes » et « oui, envoie ». Le cerveau avait bien répondu, en 10 à 15 secondes. Mais 90 millisecondes après sa réponse, l'app a reçu « interrompu » de Gemini, avant le moindre son de la réponse, et l'a jetée.

Quand la réponse finale du cerveau arrive, le Companion l'envoie à Gemini avec une consigne d'interruption. Si Gemini a encore ouverte la génération créée pour l'accusé de réception silencieux, il la clôt et signale « interrompu ». Le Companion attribuait ce signal à la réponse elle-même. Le 1ᵉʳ novembre, les mêmes étapes étaient vertes : tout dépend de ce moment.

Désormais, quand la réponse finale part tout de suite, un « interrompu » qui arrive avant tout son de la réponse est rattaché à la génération retirée, comme la fin de tour qui le suit. La réponse est lue normalement. Une vraie interruption par Amine (une nouvelle phrase, ou un arrêt demandé) coupe toujours la réponse.

La cause est déduite des journaux de l'app et du code du relais : les événements de génération de Gemini n'étaient pas enregistrés sur le S24. La prochaine recette vocale confirmera.
