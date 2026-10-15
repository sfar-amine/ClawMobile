import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';
const [adapter] = process.argv.slice(2);
let forbiddenConnections = 0;
net.Socket.prototype.connect = function () { forbiddenConnections++; throw new Error('offline_network_denied'); };
tls.connect = function () { forbiddenConnections++; throw new Error('offline_network_denied'); };
function lookup(hostname, options) {
 if (hostname !== 'search.parallel.ai') throw new Error('offline_dns_denied');
 return options?.all ? [{ address: '93.184.216.34', family: 4 }] : { address: '93.184.216.34', family: 4 };
}
dns.lookup = (hostname, options, callback) => {
 if (typeof options === 'function') { callback = options; options = {}; }
 try { const result = lookup(hostname, options); if (options?.all) callback(null, result); else callback(null, result.address, result.family); }
 catch (error) { callback(error); }
};
dns.promises.lookup = async (hostname, options) => lookup(hostname, options);
syncBuiltinESMExports();
const calls = [];
globalThis.fetch = async (url, init = {}) => {
 if (String(url) !== 'https://search.parallel.ai/mcp') throw new Error('offline_fetch_destination_denied');
 const headers = new Headers(init.headers);
 if (headers.has('authorization') || headers.has('cookie')) throw new Error('offline_credential_denied');
 const body = JSON.parse(init.body); calls.push({ method: body.method, tool: body.params?.name });
 let result;
 if (body.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'offline-real-sdk', version: '1' } };
 else if (body.method === 'notifications/initialized') return new Response('');
 else if (body.method === 'tools/call') result = { structuredContent: { results: [{ title: 'Official public fixture', url: 'https://news.samsung.com/global/', excerpts: ['Public SDK contract fixture.'] }] } };
 else throw new Error('offline_method_denied');
 return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { headers: { 'content-type': 'application/json', 'mcp-session-id': 'offline-transport-session' } });
};
// Native OpenClaw explicitly recognizes this test injection marker.
globalThis.fetch.mock = {};
const module = await import(pathToFileURL(adapter).href);
const result = await module.executeSearch({ version: 1, operation: 'search', query: 'Samsung official announcements', searchQueries: ['Samsung official announcements'], sessionId: 'c6d2a014-fbee-5262-8d63-82dcd380eae6', remainingBudgetMs: 12000, count: 5 });
let unrelatedSpecifierStillUnresolved = false;
try { await import('openclaw/plugin-sdk/text-utility-runtime'); }
catch (error) { unrelatedSpecifierStillUnresolved = error.code === 'ERR_MODULE_NOT_FOUND'; }
process.stdout.write(JSON.stringify({ result, calls, forbiddenConnections, sdkSimulated: false, httpSimulated: true, dnsSimulated: true, unrelatedSpecifierStillUnresolved })+'\n',()=>process.exit(0));
