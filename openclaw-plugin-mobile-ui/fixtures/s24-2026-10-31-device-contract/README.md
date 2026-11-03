# S24 31/10 — samantha_device_assistance absent de contracts.tools

Captures en lecture seule du journal Gateway et du transcript du cerveau (texte utilisateur retiré).

- Cœur 510e1a61 : l'outil téléphone non déclaré est seulement ignoré (« plugin tool is undeclared ») ; `samantha_agenda` reste appelé directement et l'écriture s'arrête au récapitulatif.
- Cœur 052d7b5a (outil téléphone en `direct-only`) : la Gateway refuse (« plugin must declare contracts.tools for: samantha_device_assistance ») ; le cerveau ne voit plus `samantha_agenda` (102 → 97 outils catalogués), cherche, passe par le shell, et pose une question au lieu du récapitulatif. Deux déploiements revenus en arrière par le parcours `write_recap`.
