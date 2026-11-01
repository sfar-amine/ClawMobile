# openclaw-upgrade : manifestes de compat lus à côté du script (01/11/2026)

Le préflight à blanc de la bascule 10.9 en prod (20:46) a refusé à tort : le pont Claw portait un `CLAW_RUNTIME_ROOT`
épinglé sur la release remplacée du 31/10, et `openclaw-upgrade.py` lisait ce dossier en priorité. Les superviseurs
épinglent volontairement le chemin physique de la release ; un appelant longue durée peut donc en porter un périmé.

`openclaw-upgrade.py` lit désormais `openclaw-compat` à côté de lui ; la variable ne sert que si ce dossier manque.
Test unitaire ajouté. La bascule elle-même est faite (reçu `openclaw-upgrade-20261101T204745`, deployed).
