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
        nextQuestion: String(parsed.question)
      }
    )
  }

  if (parsed && parsed.success === false) {
    if (parsed.error === 'conversation_expired') {
      return "La conversation a expiré. Relance ta demande à Claw."
    }
    return "Claw est momentanément indisponible."
  }

  const text = String((parsed && parsed.text) || '').trim()
  return text || "Claw n'a pas retourné de réponse."
}

export default function ({ conversationId, answer }) {
  const cleanConversationId = String(conversationId || '').trim()
  const cleanAnswer = String(answer || '').trim()
  if (!cleanConversationId || !cleanAnswer) {
    return "Il manque la réponse de clarification."
  }

  const url = relayUrl()
  const token = relayToken()
  if (!/^https:\/\//.test(url)) {
    console.error('ContinueClaw: invalid relay.url')
    return "Le pont Claw n'est pas configuré."
  }
  if (token.length < 24) {
    console.error('ContinueClaw: missing relay.token')
    return "Le pont Claw n'est pas authentifié."
  }

  let response
  try {
    response = http.postUrl(
      url + '/voice',
      {
        requestId: invocationId(),
        conversationId: cleanConversationId,
        answer: cleanAnswer
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
      'ContinueClaw exception: ' +
      String(error && error.message ? error.message : error)
    )
    return "Claw est momentanément indisponible."
  }

  if (!response) {
    console.error('ContinueClaw: empty response')
    return "Claw est momentanément indisponible."
  }
  const parsed = response.parsed || {}
  if (response.status < 200 || response.status >= 300) {
    console.error(
      'ContinueClaw: HTTP status=' + String(response.status)
    )
    if (parsed && parsed.error === 'conversation_expired') {
      return "La conversation a expiré. Relance ta demande à Claw."
    }
    return "Claw est momentanément indisponible."
  }

  return finish(parsed)
}
