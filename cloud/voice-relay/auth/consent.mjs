const escape = (v) => String(v).replace(/[&<>"']/g,c=>`&#${c.charCodeAt(0)};`);
export function consentPage(details,handle) {
  const scopes = details.scope.map(x=>`<li>${escape(x)}</li>`).join('');
  return `<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Samantha MCP OAuth</title><h1>Autoriser ${escape(details.clientName)} ?</h1><p>Application : ${escape(details.clientDomain||'Client non vérifié')}</p><p>Destination : ${escape(details.redirectHost)}</p><ul>${scopes}</ul><p>Autorisation limitée à la lecture de Samantha.</p><form method="post"><input type="hidden" name="handle" value="${escape(handle)}"><button name="decision" value="approve">Autoriser</button><button name="decision" value="deny">Refuser</button></form></html>`;
}
