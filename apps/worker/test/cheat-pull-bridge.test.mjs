import assert from 'node:assert/strict';
import {test, after} from 'node:test';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {createHmac} from 'node:crypto';

const bundle=await build({stdin:{contents:`
import {handleCheatServiceBridge} from './src/cheat-bridge';
import {saveCheatConfig,enqueueCheatCommand,getCheatCommand,buildCheatView,ensureCheatGuild,getLastSeen} from './src/cheat-db';
export default {async fetch(req,env){
 const u=new URL(req.url);
 if(u.pathname.startsWith('/api/cheat-bridge/')) return await handleCheatServiceBridge(req,env,u);
 const body=req.method==='GET'?{}:await req.json();
 try{
  if(u.pathname==='/t/save') return Response.json(await saveCheatConfig(env,body.guildId,body.patch));
  if(u.pathname==='/t/enqueue') return Response.json({id:await enqueueCheatCommand(env,body.guildId,body.kind,body.payload)});
  if(u.pathname==='/t/command') return Response.json(await getCheatCommand(env,body.guildId,body.id));
  if(u.pathname==='/t/view') return Response.json(buildCheatView(await ensureCheatGuild(env,body.guildId),await getLastSeen(env)));
 }catch(e){return Response.json({error:e.name,message:e.message},{status:400});}
 return new Response('missing',{status:404});
}};`,resolveDir:process.cwd(),sourcefile:'cheat-entry.ts'},bundle:true,write:false,format:'esm',platform:'browser'});

const secret='cheat-bridge-secret-longer-than-32-characters';
const G='123456789012345678', OTHER='223456789012345678', CH='323456789012345678';
const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-08-06',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],bindings:{CHEAT_BRIDGE_SECRET:secret}});
after(()=>mf.dispose());

async function bot(path,payload,{ts=String(Date.now()),sec=secret,sign=true}={}){
 const body=JSON.stringify(payload);
 const headers={'Content-Type':'application/json'};
 if(sign){
  headers['X-Cheat-Timestamp']=ts;
  headers['X-Cheat-Signature']=createHmac('sha256',sec).update([ts,'POST',path,body].join('\n')).digest('hex');
 }
 const res=await mf.dispatchFetch('https://t.example'+path,{method:'POST',headers,body});
 return {status:res.status,json:await res.json()};
}
async function admin(path,payload){
 const res=await mf.dispatchFetch('https://t.example/t/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
 return {status:res.status,json:await res.json()};
}

test('bot requests need a valid fresh signature',async()=>{
 assert.equal((await bot('/api/cheat-bridge/poll',{guilds:[G]},{sign:false})).status,401);
 assert.equal((await bot('/api/cheat-bridge/poll',{guilds:[G]},{sec:'x'.repeat(40)})).json.error,'INVALID_SIGNATURE');
 assert.equal((await bot('/api/cheat-bridge/poll',{guilds:[G]},{ts:String(Date.now()-10*60_000)})).json.error,'STALE_TIMESTAMP');
 assert.equal((await bot('/api/cheat-bridge/poll',{guilds:[G]})).status,200);
});

test('poll hands out config revisions, asks for a first report, and tracks the heartbeat',async()=>{
 const first=await bot('/api/cheat-bridge/poll',{guilds:[G],revs:{}});
 assert.equal(first.json.configs[G].rev,1);
 assert.deepEqual(first.json.needReport,[G]);
 assert.equal((await admin('view',{guildId:G})).json.online,true);
 assert.equal((await admin('view',{guildId:G})).json.reported,false);

 const report=await bot('/api/cheat-bridge/report',{guilds:[{id:G,state:{guildName:'Test',channels:[{id:CH,name:'panel',canPost:true}],panels:{puni:{messageId:'423456789012345678',deployedChannelId:CH,deployedAt:5}},counters:{puni:3}}}]});
 assert.equal(report.json.saved,1);
 const view=(await admin('view',{guildId:G})).json;
 assert.equal(view.reported,true);assert.equal(view.guildName,'Test');
 assert.deepEqual(view.channels,[{id:CH,name:'panel',canPost:true}]);
 assert.equal(view.panels.puni.deployedChannelId,CH);assert.equal(view.achievements.counters.puni,3);

 const saved=await admin('save',{guildId:G,patch:{achievements:{channelId:CH,showAmount:false},panels:{tsum:{channelId:CH,color:255}}}});
 assert.equal(saved.json.rev,2);
 const next=await bot('/api/cheat-bridge/poll',{guilds:[G],revs:{[G]:1}});
 assert.equal(next.json.configs[G].rev,2);
 assert.equal(next.json.configs[G].config.achievements.showAmount,false);
 assert.equal(next.json.configs[G].config.panels.tsum.color,255);
 assert.deepEqual(next.json.needReport,[]);
 assert.deepEqual((await bot('/api/cheat-bridge/poll',{guilds:[G],revs:{[G]:2}})).json.configs,{});
});

test('invalid settings are rejected without changing the stored revision',async()=>{
 for(const patch of [{panels:{puni:{color:-1}}},{panels:{puni:{channelId:'abc'}}},{achievements:{enabled:'yes'}},{achievements:{color:true}},'x',null]){
  const res=await admin('save',{guildId:G,patch});
  assert.equal(res.status,400,JSON.stringify(patch));assert.equal(res.json.error,'CheatInputError');
 }
 assert.equal((await bot('/api/cheat-bridge/poll',{guilds:[G],revs:{[G]:2}})).json.configs[G],undefined);
});

test('commands are delivered once, only to the guild they belong to, and results are final',async()=>{
 const {json:{id}}=await admin('enqueue',{guildId:G,kind:'deploy_panel',payload:{game:'puni',channelId:CH,color:1}});
 const stranger=await bot('/api/cheat-bridge/poll',{guilds:[OTHER],revs:{}});
 assert.deepEqual(stranger.json.commands,[]);
 const got=await bot('/api/cheat-bridge/poll',{guilds:[G],revs:{[G]:2}});
 assert.deepEqual(got.json.commands,[{id,guildId:G,kind:'deploy_panel',payload:{game:'puni',channelId:CH,color:1}}]);
 assert.equal((await admin('command',{guildId:G,id})).json.status,'running');
 assert.deepEqual((await bot('/api/cheat-bridge/poll',{guilds:[G],revs:{[G]:2}})).json.commands,[]);
 assert.equal((await bot('/api/cheat-bridge/result',{id,ok:true,result:{channelId:CH,messageId:'1',updated:false}})).json.updated,true);
 const done=(await admin('command',{guildId:G,id})).json;
 assert.equal(done.status,'done');assert.equal(done.result.updated,false);
 assert.equal((await bot('/api/cheat-bridge/result',{id,ok:false,result:{}})).json.updated,false,'a finished command cannot be rewritten');
 assert.equal((await admin('command',{guildId:OTHER,id})).json,null,'command ids are scoped to their guild');
});
