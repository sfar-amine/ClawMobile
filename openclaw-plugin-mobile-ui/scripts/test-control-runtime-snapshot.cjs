const assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
(async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'control-runtime-'));const original=os.homedir,override=process.env.SAMANTHA_CONTROL_PLAYBOOKS,clawOverride=process.env.CLAW_UI_PLAYBOOKS_ROOT;os.homedir=()=>root;delete process.env.SAMANTHA_CONTROL_PLAYBOOKS;delete process.env.CLAW_UI_PLAYBOOKS_ROOT;
 const pinned=path.join(root,'.openclaw/runtime-ui-playbooks/current'),workspace=path.join(root,'.openclaw/workspace/ui-playbooks'),custom=path.join(root,'explicit');
 try{
  for(const [dir,name] of [[pinned,'production'],[workspace,'workspace'],[custom,'explicit']]){await fs.mkdir(path.join(dir,'reporting'),{recursive:true});await fs.writeFile(path.join(dir,'reporting/__init__.py'),'');await fs.writeFile(path.join(dir,'reporting/control_snapshot.py'),`import json\nprint(json.dumps({'source':'${name}'}))\n`);}
  const api=require('../dist/companion/control');
  assert.equal((await api.readControl('automations')).source,'production');
  process.env.CLAW_UI_PLAYBOOKS_ROOT=workspace;assert.equal((await api.readControl('automations')).source,'workspace');
  process.env.SAMANTHA_CONTROL_PLAYBOOKS=custom;assert.equal((await api.readControl('automations')).source,'explicit');delete process.env.SAMANTHA_CONTROL_PLAYBOOKS;
  delete process.env.CLAW_UI_PLAYBOOKS_ROOT;
  await fs.rm(path.join(pinned,'reporting/control_snapshot.py'));assert.equal((await api.readControl('automations')).source,'workspace');
  await fs.rm(pinned,{recursive:true});assert.equal((await api.readControl('automations')).source,'workspace');
  console.log('Control reads production snapshot, explicit selection and unpinned legacy fallback');
 }finally{os.homedir=original;if(clawOverride===undefined)delete process.env.CLAW_UI_PLAYBOOKS_ROOT;else process.env.CLAW_UI_PLAYBOOKS_ROOT=clawOverride;if(override===undefined)delete process.env.SAMANTHA_CONTROL_PLAYBOOKS;else process.env.SAMANTHA_CONTROL_PLAYBOOKS=override;await fs.rm(root,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
