# HS5 — Étapes d'un run (`progress.steps[]`)

`GET /v1/runs/{id}` (route existante, aussi la lecture par `clientRunId`) ajoute à `progress` :

```
progress: { …existant (text, detail, updatedAt, events),
  steps: [{ id, label, state: pending|running|done|failed|skipped, at? }],
  failedStep?, cause?, effect: { debited: "unknown", source: "receipt" } }
```

## Source des étapes (jamais inventées)

Calcul pur à la lecture (`src/companion/runProgress.ts`) depuis le run de `runs.json`, sa décision v2 et la présentation HS3 déjà stockées, ou les événements de progression Gateway déjà lus. **Rien n'est persisté** : `runs.json` garde ses bornes (500 runs, 8 Mo).

| Run | Étapes |
|---|---|
| `capability_first`, décision EXECUTE | `accepted` (acceptedAt) → `understood` (ligne « Compris : … » si la présentation HS3 la porte) → `execute` (état du run ; `at` = fin si terminal) |
| `capability_first`, décision CLARIFY | `accepted` → `understood` → `clarify` (pending = en cours, resolved = fait, abandoned = échec) |
| `capability_first` sans décision | `accepted` → `execute` |
| Gateway | `accepted` → un pas par événement de progression enregistré (8 au plus, le dernier en cours tant que le run tourne) → `answer` |
| Voix | aucune liste (transcription seulement) |

En échec : `failedStep` = `failure.step` de la présentation HS3 (dernière étape tracée du reçu, par exemple « Exécution du paiement ») sinon le libellé de l'étape ; `cause` = `failure.reason` publique, ou l'expiration après inactivité vérifiée ; jamais l'erreur brute. `effect` reste `unknown`.

Libellés FR par défaut, EN si la présentation est en anglais.

## Paiement

Les `PaymentRecord` (`runs.json`, `paymentRequests`) ne portent pas de `runId` : aucun lien fiable run → paiement n'existe aujourd'hui. Les jalons du paiement entrent donc dans les étapes **seulement par la présentation HS3** (étape d'échec tracée). Une projection directe des jalons demanderait un lien côté paiement, hors périmètre (fichiers de paiement intouchés).

## Preuves

- `fixtures/s24-2026-10-11c/hs5-runs-shapes.json` : formes réelles des runs du S24 (Gateway en cours et terminé, capability_first EXECUTE terminé et en échec, CLARIFY résolu, sans décision, voix), lues en lecture seule.
- `scripts/test-run-progress.cjs` (CI) : étapes par forme, présentation HS3 issue d'un `PaymentRecord` réel, route `GET /v1/runs/{id}` (p95 mesuré sur 20 lectures, plafond 1,5 s en CI), non-persistance, relecture par un processus neuf.

## Retour arrière

Revert de la PR : `progress` redevient `{text, detail, updatedAt, events}`. Aucun état à restaurer.
