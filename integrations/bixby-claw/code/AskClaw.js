import http from 'http'
import config from 'config'
import secret from 'secret'

function invocationId() {
  return 'bixby-' + Date.now().toString(36) + '-' +
    Math.random().toString(36).slice(2, 10)
}

export default function askClaw(input) {
  const request = String(input.request || '').trim()
  if (!request) {
    return "Je n'ai pas reçu de demande."
  }
  const url = String(config.get('relay.url') || '').replace(/\/$/, '')
  const token = String(secret.get('relay.token') || '')
  if (!/^https:\/\//.test(url) || token.length < 24) {
    return "Le pont Claw n'est pas configuré."
  }

  const payload = {
    requestId: invocationId(),
    request: request
  }
  const response = http.postUrl(url + '/voice', payload, {
    passAsJson: true,
    returnHeaders: true,
    format: 'json',
    timeoutMs: 30000,
    headers: {
      Authorization: 'Bearer ' + token
    }
  })
  if (!response || response.status < 200 || response.status >= 300) {
    return "Claw est momentanément indisponible."
  }
  const parsed = response.parsed || {}
  if (parsed.success === false) {
    return "Claw est momentanément indisponible."
  }
  const text = String(parsed.text || '').trim()
  return text || "Claw n'a pas retourné de réponse."
}
