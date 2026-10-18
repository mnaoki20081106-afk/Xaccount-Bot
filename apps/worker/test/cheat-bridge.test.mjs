import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {build} from 'esbuild';
const result=await build({entryPoints:['src/cheat-bridge.ts'],bundle:true,write:false,format:'esm',platform:'node'});
const bridge=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
const env={CHEAT_API_BASE_URL:'https://cheat.example',CHEAT_BRIDGE_SECRET:'fixture-bridge-secret-at-least-32-characters'};
const GUILD='123456789012345678';

test('panel deploy signs exactly what Discord-Cheat verifies',async t=>{
 const original=globalThis.fetch;t.after(()=>globalThis.fetch=original);
 let seen;
 globalThis.fetch=async(url,init)=>{
  seen={url:String(url),init};
  return Response.json({ok:true,game:'puni',channelId:'223456789012345678',messageId:'1',updated:false});
 };
 await bridge.deployCheatPanel(env,GUILD,'puni',{channelId:'223456789012345678',color:255});
 const u=new URL(seen.url);
 assert.equal(u.origin+u.pathname,'https://cheat.example/bridge/main/guilds/'+GUILD+'/panels/puni');
 assert.equal(seen.init.method,'POST');
 assert.deepEqual(JSON.parse(seen.init.body),{channelId:'223456789012345678',color:255});
 const h=seen.init.headers;
 const canonical=[h.get('X-Cheat-Timestamp'),h.get('X-Cheat-Nonce'),'POST',u.pathname+u.search,seen.init.body].join('\n');
 assert.equal(h.get('X-Cheat-Signature'),createHmac('sha256',env.CHEAT_BRIDGE_SECRET).update(canonical).digest('hex'));
});

test('config PUT sends the patch and GET has no body',async t=>{
 const original=globalThis.fetch;t.after(()=>globalThis.fetch=original);
 const calls=[];
 globalThis.fetch=async(url,init)=>{calls.push({url:String(url),init});return Response.json({guildId:GUILD});};
 await bridge.getCheatConfig(env,GUILD);
 await bridge.putCheatConfig(env,GUILD,{achievements:{channelId:'223456789012345678'}});
 assert.equal(calls[0].init.method,'GET');assert.equal(calls[0].init.body,undefined);
 assert.deepEqual(JSON.parse(calls[1].init.body),{achievements:{channelId:'223456789012345678'}});
});

test('bridge errors keep status and code, misconfiguration fails closed',async t=>{
 const original=globalThis.fetch;t.after(()=>globalThis.fetch=original);
 globalThis.fetch=async()=>Response.json({error:'CHANNEL_FORBIDDEN',message:'no perms'},{status:403});
 await assert.rejects(bridge.testCheatAchievement(env,GUILD,'tsum'),e=>e instanceof bridge.CheatBridgeError&&e.status===403&&e.code==='CHANNEL_FORBIDDEN'&&e.detail==='no perms');
 let called=false;globalThis.fetch=async()=>{called=true;return Response.json({});};
 await assert.rejects(bridge.getCheatConfig({...env,CHEAT_BRIDGE_SECRET:'short'},GUILD),/CHEAT_BRIDGE_SECRET_NOT_CONFIGURED/);
 await assert.rejects(bridge.getCheatConfig({...env,CHEAT_API_BASE_URL:''},GUILD),/CHEAT_API_BASE_URL_NOT_CONFIGURED/);
 await assert.rejects(bridge.getCheatConfig({...env,CHEAT_API_BASE_URL:'http://cheat.example'},GUILD),/MUST_BE_HTTPS_ORIGIN/);
 await assert.rejects(bridge.getCheatConfig({...env,CHEAT_API_BASE_URL:'https://cheat.example/path'},GUILD),/MUST_BE_HTTPS_ORIGIN/);
 assert.equal(called,false);
});
