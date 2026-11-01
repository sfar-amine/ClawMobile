'use strict';
// Static qualification of the plugin's OpenClaw SDK version table (src/companion/openclawSdkVersions.ts) against a
// real package tree: export map, re-export lists of the plugin-sdk facades and the hashed model profile chunk.
// Reads files as text only; never imports, installs or runs OpenClaw code.
// CLI: node scripts/qualify-openclaw-sdk.cjs <package-root> <version> [--require-contract-export]
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const sha256=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

/** Names exported by an ESM facade: `export { a, b as c }` (with or without `from`) and `export const|function|class`. */
function exportNames(text){
 const names=new Set();
 for(const m of text.matchAll(/export\s*\{([^}]*)\}/g))for(const part of m[1].split(',')){const p=part.trim();if(p)names.add(p.split(/\s+as\s+/).pop().trim());}
 for(const m of text.matchAll(/export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g))names.add(m[1]);
 return [...names].sort();
}
/** Real package view: version, plugin-sdk export map and facade exports, read as text. */
function readPackage(root){
 const meta=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
 return {version:meta.version,
  facade(subpath){
   const entry=meta.exports?.['./plugin-sdk/'+subpath];const file=typeof entry==='string'?entry:entry?.default;
   if(typeof file!=='string')return null;
   const bytes=fs.readFileSync(path.join(root,file));
   return {export:file,sha256:sha256(bytes),exports:exportNames(bytes.toString('utf8'))};
  },
  chunk(relative){
   const file=path.join(root,relative);if(!fs.existsSync(file))return null;
   const bytes=fs.readFileSync(file);return {sha256:sha256(bytes),exports:exportNames(bytes.toString('utf8'))};
  }};
}
const ORDERED_SPREAD=['ownerTurn'];
/** Every row of the version's table must resolve in this package exactly as the loaders consume it. */
function qualify(table,version,pkg,{requireContractExport=false,contractHashes=null}={}){
 const errors=[],pinned=table[version];
 if(!pinned)return ['version_not_in_table:'+version];
 if(pkg.version!==version)errors.push('package_version_mismatch:'+pkg.version);
 const facades=new Map();const facade=s=>{if(!facades.has(s))facades.set(s,pkg.facade(s));return facades.get(s);};
 for(const [surfaceName,surface] of Object.entries(pinned)){
  if(surfaceName==='modelProfileContract'||surface===null)continue;
  const order=[...new Set(Object.values(surface).map(([s])=>s))];
  for(const [local,[subpath,exportName]] of Object.entries(surface)){
   const f=facade(subpath);
   if(!f){errors.push(`${surfaceName}.${local}:subpath_absent:${subpath}`);continue;}
   if(!f.exports.includes(exportName))errors.push(`${surfaceName}.${local}:export_absent:${subpath}#${exportName}`);
   // Modules are spread in first-use order: the pinned subpath must be the last one that also exports that name.
   if(ORDERED_SPREAD.includes(surfaceName)){
    const later=order.slice(order.indexOf(subpath)+1).filter(s=>facade(s)?.exports.includes(local));
    if(later.length)errors.push(`${surfaceName}.${local}:shadowed_by:${later.join(',')}`);
   }
  }
 }
 const contract=pinned.modelProfileContract,chunk=pkg.chunk(contract.module);
 if(!chunk)errors.push('modelProfileContract:chunk_absent:'+contract.module);
 else{
  if(contractHashes&&!contractHashes.includes(chunk.sha256))errors.push('modelProfileContract:chunk_hash_unpinned:'+chunk.sha256);
  if(requireContractExport&&!chunk.exports.includes(contract.symbol))errors.push('modelProfileContract:export_absent:'+contract.symbol);
 }
 return errors;
}
/** The model-flow-selection set pins the contract chunk's original and patched bytes for each version. */
function contractHashesFromManifest(manifest,version,module){
 const files=manifest.package_version===version?manifest.files:manifest.packages?.[version]?.files;
 const row=(files||[]).find(f=>f.root==='openclaw'&&f.path===module);
 return row?[row.original,row.patched]:[];
}
module.exports={exportNames,readPackage,qualify,contractHashesFromManifest};

if(require.main===module){
 const [root,version,...flags]=process.argv.slice(2);
 if(!root||!version){console.error('usage: qualify-openclaw-sdk.cjs <package-root> <version> [--require-contract-export]');process.exit(2);}
 const {OPENCLAW_SDK_VERSIONS}=require('../dist/companion/openclawSdkVersions');
 const manifest=JSON.parse(fs.readFileSync(path.join(__dirname,'../../installer/termux-lite/openclaw-compat/model-flow-selection.json'),'utf8'));
 const pinned=OPENCLAW_SDK_VERSIONS[version];
 const hashes=pinned?contractHashesFromManifest(manifest,version,pinned.modelProfileContract.module):[];
 const errors=pinned&&!hashes.length?['modelProfileContract:not_pinned_by_model_flow_selection']:[];
 errors.push(...qualify(OPENCLAW_SDK_VERSIONS,version,readPackage(path.resolve(root)),{requireContractExport:flags.includes('--require-contract-export'),contractHashes:hashes}));
 const rows=pinned?Object.values(pinned).filter(s=>s&&!s.module).reduce((n,s)=>n+Object.keys(s).length,0):0;
 console.log(JSON.stringify({test:'OpenClaw SDK surface qualification',version,rows,contract:pinned?.modelProfileContract.module,ok:!errors.length,errors}));
 if(errors.length)process.exitCode=1;
}
