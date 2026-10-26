import http from 'http'
import config from 'config'
import secret from 'secret'
import fail from 'fail'
import console from 'console'

function invocationId() {
  return 'bixby-' +
    Date.now().toString(36) +
    '-' +
    Math.random().toString(36).slice(2, 10)
}

function relayUrl() {
  return String(config.get('relay.url') || '').replace(/\/$/, '')
}

function relayToken() {
  return String(secret.get('relay.token') || '')
}

function finish(parsed) {
  if (
    parsed &&
    parsed.state === 'needs_clarification' &&
    parsed.question &&
    parsed.conversationId
  ) {
    throw fail.checkedError(
      'Claw needs clarification',
      'NeedsClarification',
      {
        question: String(parsed.question),
        conversationId: String(parsed.conversationId)
      }
    )
  }

  if (parsed && parsed.success === false) {
    if (parsed.state === 'unknown') {
      return "Le résultat de la demande reste à vérifier. Je ne la relance pas."
    }
    if (parsed.error === 'missing_scope' || parsed.error === 'voice_owner_admission_required' || parsed.error === 'owner_admission_required') {
      return "L'accès autorisé à cette entrée vocale ne permet pas cette demande."
    }
    if (parsed.error === 'conversation_expired') {
      return "La conversation a expiré. Relance ta demande à Claw."
    }
    return "Claw est momentanément indisponible."
  }

  const text = String((parsed && parsed.text) || '').trim()
  return text || "Claw n'a pas retourné de réponse."
}

export default function ({ request }) {
  const cleanRequest = String(request || '').trim()
  if (!cleanRequest) {
    return "Je n'ai pas reçu de demande."
  }

  const url = relayUrl()
  const token = relayToken()
  if (!/^https:\/\//.test(url)) {
    console.error('AskClaw: invalid relay.url')
    return "Le pont Claw n'est pas configuré."
  }
  if (token.length < 24) {
    console.error('AskClaw: missing relay.token')
    return "Le pont Claw n'est pas authentifié."
  }

  let response
  try {
    response = http.postUrl(
      url + '/voice',
      {
        requestId: invocationId(),
        request: cleanRequest
      },
      {
        passAsJson: true,
        returnHeaders: true,
        format: 'json',
        headers: {
          Authorization: 'Bearer ' + token
        }
      }
    )
  } catch (error) {
    console.error(
      'AskClaw exception: ' +
      String(error && error.message ? error.message : error)
    )
    return "Claw est momentanément indisponible."
  }

  if (!response) {
    console.error('AskClaw: empty response')
    return "Claw est momentanément indisponible."
  }
  const parsed = response.parsed || {}
  if (response.status < 200 || response.status >= 300) {
    console.error('AskClaw: HTTP status=' + String(response.status))
    if (parsed && parsed.error === 'conversation_expired') {
      return "La conversation a expiré. Relance ta demande à Claw."
    }
    return parsed.success === false ? finish(parsed) : "Claw est momentanément indisponible."
  }

  return finish(parsed)
}
