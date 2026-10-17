/** S24 qualification receipt of the canonical memo STT owner (17/10/2026).
 * Deep-equal to fixtures/s24-2026-10-17/hs8-qualification/qualification-receipt.json
 * (test-memo-stt-boundary.cjs compares them). Data only: it is checked by qualifyMemoStt, never trusted as a boolean. */
export const MEMO_STT_QUALIFICATION_RECEIPT: unknown = {
  "schemaVersion": 1,
  "kind": "hs8_memo_stt_qualification",
  "id": "hs8-memo-stt-s24-20261017",
  "capturedAt": "2026-10-17",
  "verdict": "QUALIFIE_PROPRIETAIRE_CANONIQUE_S24",
  "provenance": {
    "runtime": {
      "branch": "runtime/samantha-companion-private",
      "head": "636becf5",
      "node": "v24.21.0"
    },
    "method": "dist/companion installé du Companion (memoSttOwner.loadMemoMediaOwner puis runMemoAudioOwner), binaire, cwd et environnement exacts du process Companion (/proc/<pid>/environ via env -i). Aucun run, aucune route, aucune écriture runtime ; dossier ~/.openclaw/tmp/memo-qual-20261017 supprimé ensuite.",
    "distSha256": {
      "memoSttOwner.js": "d82a22dee6570c3bbf469bf06839f8ad15d2ef41515f586c78685458d7476a0e",
      "memoSttBoundary.js": "6aeffa89514dfaca0d2e9983930b92a53af17d40d6f0e643802e912be0843888",
      "attachmentStorage.js": "768c0f471a2ddb52d26c6649d1adf59529adf41003e20c3e1b34ea4f9e709bd8"
    },
    "request_ids": [
      "mcp-claude-chat-memo-diag-20261017-a-diag1",
      "mcp-claude-chat-memo-qual-20261017-push-push1",
      "mcp-claude-chat-memo-qual-20261017-run-run1",
      "mcp-claude-chat-memo-qual-20261017-run-run3-provider",
      "mcp-claude-chat-memo-diag-20261017-a-logpriv2",
      "mcp-claude-chat-memo-qual-20261017-clean-clean1"
    ]
  },
  "owner": {
    "module": "memoSttOwner.runMemoAudioOwner",
    "sdk": {
      "package": "openclaw",
      "version": "2026.9.6",
      "resolution": "npm root -g (sans NODE_PATH)",
      "coldLoadMs": 7258
    },
    "provider": "google",
    "model": "gemini-3.5-flash-lite",
    "profile": "google:claw-gemini-free",
    "promptSha256": "29f1b3f2ce280fb4ab45368248d9252505a76d179de15694aa3c1aee0188e2f3"
  },
  "config": {
    "freeProfile": {
      "present": true,
      "provider": "google",
      "mode": "api_key"
    },
    "mediaModelsOnDisk": 0,
    "audioExplicitlyDisabled": false,
    "providersGoogleHasApiKey": true,
    "projectionExcludesProviderApiKey": true,
    "globalConfigUnchanged": true,
    "primaryBlockedEnvNames": 0
  },
  "authPreflight": {
    "lockedProfile": true,
    "profileId": "google:claw-gemini-free",
    "mode": "api-key",
    "source": "profile:google:claw-gemini-free",
    "ms": 306
  },
  "samples": [
    {
      "id": "synthetic_mp42_aac16k",
      "file": "memo-fr-synthetic.m4a",
      "origin": "espeak-ng (voix fr) puis ffmpeg AAC LC 16 kHz mono 16 kb/s, conteneur MPEG-4 marque mp42/isom comme MediaRecorder (VoiceMemo.kt). Synthétisé hors S24, aucune voix ni donnée personnelle.",
      "bytes": 7419,
      "sha256": "a1105052ff9672c5687207637bfef7aaf471c2b5d0808552d4739e7ef66ac19b",
      "majorBrand": "mp42",
      "durationSeconds": 2.644,
      "isM4aContainer": true,
      "durationWithinLimit": true,
      "spoken": "Bonjour Samantha, ceci est un test.",
      "runs": [
        {
          "attempt": 1,
          "ms": 2313,
          "success": true,
          "state": "transcribed",
          "text": "Pour vous Samantha, ceci est un test.",
          "attempts": [
            {
              "provider": "google",
              "model": "gemini-3.5-flash-lite",
              "outcome": "success"
            }
          ]
        },
        {
          "attempt": 2,
          "ms": 1311,
          "success": true,
          "state": "transcribed",
          "text": "pour une semaine, ceci est un test.",
          "attempts": [
            {
              "provider": "google",
              "model": "gemini-3.5-flash-lite",
              "outcome": "success"
            }
          ]
        },
        {
          "attempt": 3,
          "ms": 3365,
          "success": true,
          "state": "transcribed",
          "text": "Pour un samassa ce si est un test.",
          "attempts": [
            {
              "provider": "google",
              "model": "gemini-3.5-flash-lite",
              "outcome": "success"
            }
          ]
        }
      ],
      "note": "Chemin conteneur Android (mp42) et chaîne complète validés. La voix espeak-ng est robotique : le premier mot est mal reconnu, ce qui ne mesure pas la précision sur une voix humaine."
    },
    {
      "id": "fixture_hs8_174",
      "file": "../../s24-2026-10-11/hs8-captures/bonjour-samantha.m4a",
      "origin": "Parole synthétique Gemini Live, core #174 (aucune donnée personnelle).",
      "bytes": 12967,
      "sha256": "45b72fe4f79215f6ab6f4366239a79117330f355cc2bf17f745bce29b929c826",
      "majorBrand": "M4A ",
      "durationSeconds": 1.91,
      "isM4aContainer": true,
      "durationWithinLimit": true,
      "spoken": "Bonjour Samantha",
      "runs": [
        {
          "attempt": 1,
          "ms": 1643,
          "success": true,
          "state": "transcribed",
          "text": "bonjour Samantha",
          "attempts": [
            {
              "provider": "google",
              "model": "gemini-3.5-flash-lite",
              "outcome": "success"
            }
          ]
        }
      ]
    }
  ],
  "openaiCalled": false,
  "runtimeWrites": "none",
  "personalData": false,
  "logPrivacy": {
    "method": "Recherche du texte transcrit et des noms de fichiers dans tous les fichiers de ~/.openclaw, ~/.cache, $PREFIX/tmp et ~/ClawMobile modifiés dans les 30 min.",
    "transcriptOrAudioPathPersistedBySdk": false,
    "onlyHits": "reçus Claw de ces commandes de qualification (remote-bridge/requests, processes)"
  },
  "notQualifiedHere": [
    "Enregistrement réel du recorder Android de l'app (VoiceMemo.kt) : marque, durée, taille, SHA d'un vrai mémo",
    "Précision sur voix humaine, français et derja (arabizi)",
    "Parcours HTTP complet POST /v1/attachments puis POST /v1/runs avec admission P1 fraîche de l'app, budgets cumulés et journaux du process Companion",
    "Délai global SDK en cas de fournisseur bloqué (timeoutSeconds 60 par modèle seulement)"
  ]
};
