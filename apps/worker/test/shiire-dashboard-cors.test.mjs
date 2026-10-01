import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';

const bundle=await build({stdin:{contents:`
import {createDashboardSession} from './src/db';
import {sha256Hex} from './src/utils';
import {handleShiireDashboardProxy} from './src/shiire-bridge';
export default {async fetch(request,env){
 if(new URL(request.url).pathname==='/fixture-session'){
  await createDashboardSession(env,await sha256Hex('fixture-session'),Date.now()+60000);
  return Response.json({ok:true});
 }
 return await handleShiireDashboardProxy(request,env,new URL(request.url))??new Response('missing',{status:404});
}};`,resolveDir:process.cwd(),sourcefile:'shiire-cors-fixture.ts'},bundle:true,write:false,format:'esm',platform:'browser'});

for(const status of [200,409,503])test('Shiire dashboard proxy exposes upstream status '+status+' to cross-origin browsers',async t=>{
 const zeroBudget={percentages:{INVITE_CAMPAIGN:0,NO_SHADOWBAN:50,TOP_SEARCH:50},budget:{initialized:false,available:{INVITE_CAMPAIGN:0,NO_SHADOWBAN:0,TOP_SEARCH:0},totalAvailableUsd:0,updatedAt:0}};
 const payload=status===200?zeroBudget:{message:'fixture-upstream-error'};
 let signedCalls=0;
 const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-08-06',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],bindings:{DISCORD_BOT_TOKEN:'fixture',SHIIRE_API_BASE_URL:'https://shiire.example',SHIIRE_BRIDGE_SECRET:'fixture-secret-at-least-32-characters'},outboundService:async request=>{
  const url=new URL(request.url);
  if(url.hostname==='discord.com')return Response.json({id:'123456789012345678'});
  assert.equal(url.origin,'https://shiire.example');
  assert.equal(url.pathname,'/bridge/main/guilds/123456789012345678/procurement-budget');
  assert.ok(request.headers.get('X-Shiire-Signature'));
  signedCalls++;
  return Response.json(payload,{status});
 }});
 t.after(()=>mf.dispose());
 await mf.dispatchFetch('https://api.example/fixture-session');
 const response=await mf.dispatchFetch('https://api.example/api/guilds/123456789012345678/shiire/procurement-budget',{headers:{Authorization:'Bearer fixture-session',Origin:'https://mnaoki20081106-afk.github.io'}});
 assert.equal(response.status,status);
 assert.equal(response.headers.get('Access-Control-Allow-Origin'),'*','missing CORS headers make Safari fetch fail with Load failed');
 assert.match(response.headers.get('Access-Control-Allow-Headers'),/Authorization/);
 assert.equal(response.headers.get('Cache-Control'),'no-store');
 assert.deepEqual(await response.json(),payload);
 assert.equal(signedCalls,1);
});
