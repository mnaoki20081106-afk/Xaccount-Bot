import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const result=await build({entryPoints:['src/xutility-bridge.ts'],bundle:true,write:false,format:'esm',platform:'node'});
const {postXUtilityPanel}=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
test('format panel bridge signs the new path and forwards the exact channel',async t=>{
 const original=globalThis.fetch;t.after(()=>globalThis.fetch=original);
 globalThis.fetch=async(url,init)=>{
  assert.equal(String(url),'https://utility.example/bridge/main/guilds/123456789012345678/panels/account-format');assert.equal(init.method,'POST');assert.deepEqual(JSON.parse(init.body),{channelId:'223456789012345678'});assert.ok(init.headers.get('X-XUtility-Signature'));
  return Response.json({ok:true,messageId:'323456789012345678'});
 };
 const response=await postXUtilityPanel({XUTILITY_API_BASE_URL:'https://utility.example',XUTILITY_BRIDGE_SECRET:'fixture-bridge-secret-at-least-32-characters'},'123456789012345678','account-format','223456789012345678');assert.equal(response.messageId,'323456789012345678');
});
