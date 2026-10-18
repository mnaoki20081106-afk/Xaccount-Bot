import assert from 'node:assert/strict';
import {test} from 'node:test';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
test('panel and achievement settings are sent to the cheat bridge routes',{timeout:60000},async t=>{
 const dir=await mkdtemp(path.resolve('.cheat-ui-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 await build({entryPoints:['src/CheatManager.tsx'],bundle:true,platform:'node',format:'esm',packages:'external',outfile:path.join(dir,'Manager.mjs'),loader:{'.css':'empty'},define:{'import.meta.env.VITE_API_BASE_URL':'"https://fixture.example"'},jsx:'automatic'});
 const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'https://fixture.example'});
 for(const key of ['window','document','navigator','HTMLElement','Element','Node','MutationObserver','localStorage','sessionStorage','location','getComputedStyle'])Object.defineProperty(globalThis,key,{value:key==='getComputedStyle'?dom.window.getComputedStyle.bind(dom.window):dom.window[key],configurable:true});
 globalThis.IS_REACT_ACT_ENVIRONMENT=true;t.after(()=>dom.window.close());
 const React=await import('react');const {render,screen,waitFor,cleanup,within,fireEvent}=await import('@testing-library/react');
 const {default:userEvent}=await import('@testing-library/user-event');t.after(cleanup);
 const {default:Manager}=await import(pathToFileURL(path.join(dir,'Manager.mjs')).href);
 const nativeFetch=globalThis.fetch;t.after(()=>globalThis.fetch=nativeFetch);
 const games=[{key:'nyanko',label:'にゃんこ大戦争',panelName:'にゃんこ大戦争パネル',defaultColor:0x2b2d31},{key:'tsum',label:'ツムツム',panelName:'ツムツムパネル',defaultColor:0x06c755},{key:'puni',label:'ぷにぷに',panelName:'ぷにぷにパネル',defaultColor:0x5865f2}];
 const blank={channelId:null,color:null,messageId:null,deployedChannelId:null,deployedAt:null};
 const config={guildId:'123456789012345678',guildName:'g',online:true,reported:true,lastSeenAt:Date.now(),games,panels:{nyanko:{...blank},tsum:{...blank},puni:{...blank}},
  achievements:{enabled:true,channelId:null,color:5763719,showAmount:true,showUser:true,games:{nyanko:{enabled:true,channelId:null},tsum:{enabled:true,channelId:null},puni:{enabled:true,channelId:null}},counters:{nyanko:0,tsum:0,puni:0}},
  channels:[{id:'11111111111111111',name:'panel',canPost:true},{id:'22222222222222222',name:'jisseki',canPost:true},{id:'33333333333333333',name:'locked',canPost:false}]};
 const calls=[];
 globalThis.fetch=async(input,init={})=>{
  const u=new URL(String(input));const method=init.method??'GET';
  calls.push({path:u.pathname,method,body:init.body?JSON.parse(init.body):null});
  if(u.pathname.endsWith('/cheat/config')&&method==='PUT'){
   const patch=JSON.parse(init.body);
   if(patch.achievements)Object.assign(config.achievements,patch.achievements);
   return Response.json(config);
  }
  if(u.pathname.endsWith('/cheat/config'))return Response.json(config);
  if(u.pathname.includes('/cheat/panels/'))return Response.json({ok:true,commandId:'cmd-panel-0001'},{status:202});
  if(u.pathname.endsWith('/cheat/commands/cmd-panel-0001')){config.panels.puni={...config.panels.puni,messageId:'9',deployedChannelId:'11111111111111111',channelId:'11111111111111111',deployedAt:1};return Response.json({id:'cmd-panel-0001',status:'done',result:{channelId:'11111111111111111',messageId:'9',updated:false},online:true});}
  if(u.pathname.endsWith('/achievements/test'))return Response.json({ok:true,commandId:'cmd-test-00001'},{status:202});
  if(u.pathname.endsWith('/cheat/commands/cmd-test-00001'))return Response.json({id:'cmd-test-00001',status:'failed',result:{error:'CHANNEL_FORBIDDEN',message:'no perms'},online:true});
  throw new Error('unexpected '+u.pathname);
 };
 const errors=[];
 render(React.createElement(Manager,{guildId:'123456789012345678',onNotice:()=>{},onError:e=>errors.push(e)}));
 const user=userEvent.setup();
 const card=(await screen.findByRole('heading',{name:'ぷにぷにパネル'})).closest('article');
 const select=within(card).getByRole('combobox');
 assert.deepEqual([...select.options].map(o=>o.textContent),['チャンネルを選択','#panel','#jisseki'],'channels the cheat bot cannot post to are hidden');
 await user.selectOptions(select,'11111111111111111');
 fireEvent.change(within(card).getByLabelText('ぷにぷにパネルの色'),{target:{value:'#ff0000'}});
 await user.click(within(card).getByRole('button',{name:'パネルを設置'}));
 await waitFor(()=>assert.ok(calls.some(c=>c.method==='POST'&&c.path.endsWith('/cheat/panels/puni'))));
 assert.match(within(card).getByRole('status').textContent,/依頼しました/,'the UI says it is waiting for the bot');
 assert.deepEqual(calls.find(c=>c.path.endsWith('/cheat/panels/puni')).body,{channelId:'11111111111111111',color:0xff0000});
 await waitFor(()=>assert.match(within(card).getByRole('status').textContent,/パネルを設置しました: #panel/),{timeout:10000});
 assert.ok(calls.some(c=>c.method==='GET'&&c.path.endsWith('/cheat/commands/cmd-panel-0001')),'the result is polled from the command endpoint');
 const ach=screen.getByRole('heading',{name:'実績'}).closest('article');
 await user.selectOptions(within(ach).getByLabelText('実績の投稿先チャンネル'),'22222222222222222');
 await user.click(within(ach).getByLabelText('金額を表示する'));
 await user.click(within(ach).getByRole('button',{name:'実績設定を保存'}));
 await waitFor(()=>assert.ok(calls.some(c=>c.method==='PUT'&&c.body.achievements)));
 const sent=calls.filter(c=>c.method==='PUT'&&c.body.achievements).pop().body.achievements;
 assert.equal(sent.channelId,'22222222222222222');assert.equal(sent.showAmount,false);assert.equal('counters' in sent,false);
 await user.click(within(ach).getByRole('button',{name:'ツムツムでテスト送信'}));
 await waitFor(()=>assert.deepEqual(calls.filter(c=>c.path.endsWith('/achievements/test')).map(c=>c.body),[{game:'tsum'}]));
 await waitFor(()=>assert.match(within(ach).getAllByRole('status').pop().textContent,/投稿できません/),{timeout:10000});
 assert.equal(errors.length,0);
});

test('a bot that never reported shows the connection help instead of empty editors',async t=>{
 const dir=await mkdtemp(path.resolve('.cheat-ui-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 await build({entryPoints:['src/CheatManager.tsx'],bundle:true,platform:'node',format:'esm',packages:'external',outfile:path.join(dir,'Manager.mjs'),loader:{'.css':'empty'},define:{'import.meta.env.VITE_API_BASE_URL':'"https://fixture.example"'},jsx:'automatic'});
 const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'https://fixture.example'});
 for(const key of ['window','document','navigator','HTMLElement','Element','Node','MutationObserver','localStorage','sessionStorage','location','getComputedStyle'])Object.defineProperty(globalThis,key,{value:key==='getComputedStyle'?dom.window.getComputedStyle.bind(dom.window):dom.window[key],configurable:true});
 globalThis.IS_REACT_ACT_ENVIRONMENT=true;t.after(()=>dom.window.close());
 const React=await import('react');const {render,within,cleanup}=await import('@testing-library/react');t.after(cleanup);const page=within(document.body);
 const {default:Manager}=await import(pathToFileURL(path.join(dir,'Manager.mjs')).href);
 const nativeFetch=globalThis.fetch;t.after(()=>globalThis.fetch=nativeFetch);
 globalThis.fetch=async()=>Response.json({guildId:'123456789012345678',guildName:'',online:false,reported:false,lastSeenAt:null,games:[],panels:{},achievements:{},channels:[]});
 render(React.createElement(Manager,{guildId:'123456789012345678',onNotice:()=>{},onError:()=>{}}));
 assert.ok(await page.findByRole('heading',{name:'Discord-Cheat BOTの接続待ち'}));
 assert.match(page.getByRole('status').textContent,/XACCOUNT_BOT_URL/);
});
