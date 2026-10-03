import assert from 'node:assert/strict';
import {test} from 'node:test';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

test('budget navigation validates percentages, saves the three classes and reloads persisted values',async t=>{
 const dir=await mkdtemp(path.resolve('.shiire-ui-test-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 await build({entryPoints:['src/ShiireOperationsCenter.tsx'],bundle:true,platform:'node',format:'esm',packages:'external',loader:{'.css':'empty'},outfile:path.join(dir,'Shiire.mjs'),define:{'import.meta.env.VITE_API_BASE_URL':'"https://fixture.example"'},jsx:'automatic'});
 const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'https://fixture.example'});
 for(const key of ['window','document','navigator','HTMLElement','Element','Node','MutationObserver','localStorage','sessionStorage','location','getComputedStyle']) Object.defineProperty(globalThis,key,{value:key==='getComputedStyle'?dom.window.getComputedStyle.bind(dom.window):dom.window[key],configurable:true});
 globalThis.IS_REACT_ACT_ENVIRONMENT=true;
 t.after(()=>dom.window.close());
 const React=await import('react');
 const {render,screen,waitFor,cleanup,act,within}=await import('@testing-library/react');
 const {default:userEvent}=await import('@testing-library/user-event');
 t.after(cleanup);
 const {default:Shiire}=await import(pathToFileURL(path.join(dir,'Shiire.mjs')).href);
 let percentages={INVITE_CAMPAIGN:0,NO_SHADOWBAN:50,TOP_SEARCH:50};
 const writes=[],errors=[],automationWrites=[],settingsWrites=[],restockWrites=[];
 let limitsFailure=false;
 let controls={max_unit_price_jpy:80,max_no_shadowban_unit_price_usd:0.6};
 let restock={config:{enabled:true,top_search_target_stock:20,no_shadowban_target_stock:20,notification_channel_id:'',notification_message:'入荷しました'}};
 const nativeConfirm=globalThis.confirm;
 globalThis.confirm=()=>true;
 t.after(()=>{globalThis.confirm=nativeConfirm;});
 let budgetFailure=false,zeroBudget=false;
 const overview={generatedAt:Date.now(),safety:{fundingMode:'manual_hstora',fundingModeLabel:'LTC手動補充',dryRun:true,emergencyStop:false,autoProcurementEnabled:false},settings:{},funding:{ok:true,data:{}},balances:{hstora:{ok:true,data:{balance:100,currency:'USD'}}},inventoryByClass:{NO_SHADOWBAN:{READY_FOR_DELIVERY:12},TOP_SEARCH:{READY_FOR_DELIVERY:8},INVITE_CAMPAIGN:{READY_FOR_DELIVERY:3}},today:{count:0,amount:0},circuitBreakers:[],recentErrors:[],providerIssues:[],integrations:{hstoraConfigured:true,credentialsEncryptionConfigured:true},recentOrders:[]};
 const nativeFetch=globalThis.fetch;
 t.after(()=>{globalThis.fetch=nativeFetch});
 globalThis.fetch=async(input,init={})=>{
  const p=new URL(String(input)).pathname;
  if(p.endsWith('/operations/overview'))return Response.json(overview);
  if(p.endsWith('/automation-settings')){
   const patch=JSON.parse(init.body);automationWrites.push(patch);
   overview.safety.dryRun=patch.dry_run??overview.safety.dryRun;
   overview.safety.autoProcurementEnabled=patch.auto_procurement_enabled;
   return Response.json({ok:true});
  }
  if(p.endsWith('/operations/logs'))return Response.json({logs:[],breakers:[],fundingEvents:[],cryptoTransactions:[]});
  if(p.endsWith('/operations/orders'))return Response.json({orders:[{id:'order',procurement_class:'TOP_SEARCH',status:'COMPLETED',quantity:2,unit_price:0.5,currency:'USD',supplier_product_id:123,created_at:Date.now()}],statusSummary:{}});
  if(p.endsWith('/daily-restock'))return Response.json(restock);
  if(p.endsWith('/procurement-settings')){
   if(init.method==='PATCH'){
    if(limitsFailure)return Response.json({message:'limits unavailable'},{status:503});
    const patch=JSON.parse(init.body);settingsWrites.push(patch);controls={...controls,...patch};
   }
   return Response.json(controls);
  }
  if(p.endsWith('/daily-restock/settings')){
   const patch=JSON.parse(init.body);restockWrites.push(patch);
   restock={config:{...restock.config,enabled:patch.enabled,top_search_target_stock:patch.topSearchTargetStock,no_shadowban_target_stock:patch.noShadowbanTargetStock,notification_channel_id:patch.notificationChannelId,notification_message:patch.notificationMessage,notification_mention:patch.notificationMention}};
   return Response.json(restock);
  }
  if(p.endsWith('/procurement-budget')){
   if(budgetFailure)return Response.json({message:'INVALID_BRIDGE_SIGNATURE'},{status:401});
   if(init.method==='POST'){
    const payload=JSON.parse(init.body);writes.push(payload);
    percentages={INVITE_CAMPAIGN:payload.inviteCampaignPercent,NO_SHADOWBAN:payload.noShadowbanPercent,TOP_SEARCH:payload.topSearchPercent};
   }
   return Response.json({percentages,budget:{initialized:true,available:zeroBudget?{INVITE_CAMPAIGN:0,NO_SHADOWBAN:0,TOP_SEARCH:0}:{INVITE_CAMPAIGN:0,NO_SHADOWBAN:50,TOP_SEARCH:50},totalAvailableUsd:zeroBudget?0:100,updatedAt:Date.now()}});
  }
  throw new Error('Unexpected request: '+p);
 };
 const props={guildId:'fixture',channels:[],roles:[{id:'123456789012345678',name:'入荷通知',isEveryone:false}],onNotice:()=>{},onError:error=>errors.push(error)};
 const user=userEvent.setup();render(React.createElement(Shiire,props));
 await screen.findByText('$100');
 assert.equal(screen.queryByRole('spinbutton'),null,'overview contains no settings wall');
 assert.deepEqual(within(screen.getByRole('navigation')).getAllByRole('button').map(button=>button.textContent),['運用状況','仕入れ設定','販売設定','履歴と問題']);
 await user.click(screen.getByRole('button',{name:'自動仕入れを開始'}));
 await screen.findByRole('button',{name:'自動仕入れを一時停止'});
 assert.deepEqual(automationWrites[0],{dry_run:false,auto_procurement_enabled:true,confirmLive:true});
 await waitFor(()=>assert.equal(screen.getByRole('button',{name:'自動仕入れを一時停止'}).disabled,false));
 await user.click(screen.getByRole('button',{name:'自動仕入れを一時停止'}));
 await screen.findByRole('button',{name:'自動仕入れを開始'});
 assert.deepEqual(automationWrites[1],{auto_procurement_enabled:false,confirmLive:false});
 assert.equal(screen.getByText('直近の注文').parentElement.open,false);
 assert.equal(screen.getByText('連携状態').parentElement.open,false);
 await user.click(screen.getByRole('button',{name:'仕入れ設定'}));
 const shadow=await screen.findByRole('spinbutton',{name:'シャドウバンなしの割合'});
 const top=screen.getByRole('spinbutton',{name:'検索上位の割合'});
 const invite=screen.getByRole('spinbutton',{name:'招待特典用の割合'});
 const save=screen.getByRole('button',{name:'仕入れ設定を保存'});
 await waitFor(()=>assert.equal(save.disabled,false));
 await user.clear(shadow);await user.type(shadow,'60');
 assert.equal(save.disabled,true);assert.equal(writes.length,0);
 await user.clear(top);await user.type(top,'30');
 await user.clear(invite);await user.type(invite,'10');
 assert.equal(save.disabled,false);
 await user.clear(shadow);await user.type(shadow,'60.5');
 await user.clear(top);await user.type(top,'29.5');
 assert.equal(save.disabled,true,'fractions must not save even when total is 100');
 await user.clear(shadow);await user.type(shadow,'110');
 await user.clear(top);await user.type(top,'-20');
 assert.equal(save.disabled,true,'out-of-range percentages must not save even when total is 100');
 await user.clear(shadow);await user.type(shadow,'60');
 await user.clear(top);await user.type(top,'30');
 await user.click(save);
 await waitFor(()=>assert.equal(writes.length,1));
 assert.deepEqual(writes[0],{inviteCampaignPercent:10,noShadowbanPercent:60,topSearchPercent:30});
 await waitFor(()=>assert.equal(save.disabled,false));
 // A stock-only save must never rebalance unchanged budget or touch advanced filters.
 await user.clear(screen.getByLabelText('検索上位の在庫目標（個）'));await user.type(screen.getByLabelText('検索上位の在庫目標（個）'),'30');
 await user.click(save);
 await waitFor(()=>assert.equal(restockWrites.length,1));
 await waitFor(()=>assert.equal(save.disabled,false));
 assert.equal(writes.length,1);assert.equal(settingsWrites.length,0);
 assert.equal(restockWrites[0].topSearchTargetStock,30);
 // Validate every group before making any write.
 await user.clear(shadow);await user.type(shadow,'55');await user.clear(top);await user.type(top,'35');
 const limit=screen.getByLabelText('シャドウバンなしの単価上限（USD）');
 await user.clear(limit);await user.type(limit,'0.7');await user.click(save);
 assert.equal(writes.length,1,'invalid price must prevent budget changes too');
 assert.match(errors.pop().message,/0.50〜0.60/);
 await user.clear(limit);await user.type(limit,'0.55');
 limitsFailure=true;await user.click(save);
 await waitFor(()=>assert.equal(errors.length,1));
 assert.match(errors.pop().message,/予算配分は保存済み/);
 assert.equal(writes.length,2);assert.equal(limit.value,'0.55','failed save keeps input');
 limitsFailure=false;await waitFor(()=>assert.equal(save.disabled,false));await user.click(save);
 await waitFor(()=>assert.equal(settingsWrites.length,1));
 await waitFor(()=>assert.equal(save.disabled,false));
 assert.equal(writes.length,2,'retry must skip an already saved budget');
 assert.deepEqual(settingsWrites[0],{max_unit_price_jpy:80,max_no_shadowban_unit_price_usd:0.55});
 assert.equal(restockWrites.length,1);
 cleanup();render(React.createElement(Shiire,props));
 await screen.findByText('$100');
 await user.click(screen.getByRole('button',{name:'仕入れ設定'}));
 assert.equal((await screen.findByRole('spinbutton',{name:'シャドウバンなしの割合'})).value,'55');
 assert.equal(screen.getByRole('spinbutton',{name:'検索上位の割合'}).value,'35');
 assert.equal(screen.getByRole('spinbutton',{name:'招待特典用の割合'}).value,'10');
 assert.deepEqual(errors,[]);
 await user.click(screen.getByText('18時の入荷まとめ通知'));
 await user.click(screen.getByRole('button',{name:'指定の通知文に戻す'}));
 await user.selectOptions(screen.getByLabelText('メンション先'),'123456789012345678');
 const template=screen.getByLabelText('入荷時のメッセージ').value;
 assert.match(template,/^\{mention\}/);assert.match(template,/現在在庫 : \{normal_stock\}個（\+\{normal_added\}個）/);
 assert.match(template,/②【Old】Top Search \+ No shadow ban/);
 await user.click(screen.getByRole('button',{name:'仕入れ設定を保存'}));
 await waitFor(()=>assert.equal(restockWrites.at(-1).notificationMessage,template));
 assert.equal(restockWrites.at(-1).notificationMention,'123456789012345678');
 await waitFor(()=>assert.equal(screen.getByRole('button',{name:'仕入れ設定を保存'}).disabled,false));
 await user.clear(screen.getByLabelText('入荷時のメッセージ'));
 await user.type(screen.getByLabelText('入荷時のメッセージ'),'カスタム入荷通知');
 await user.click(screen.getByRole('button',{name:'仕入れ設定を保存'}));
 await waitFor(()=>assert.equal(restockWrites.at(-1).notificationMessage,'カスタム入荷通知'));
 await waitFor(()=>assert.equal(screen.getByRole('button',{name:'仕入れ設定を保存'}).disabled,false));
 await user.click(screen.getByRole('button',{name:'運用状況'}));
 await user.click(screen.getByRole('button',{name:'仕入れ設定'}));
 assert.equal((await screen.findByLabelText('入荷時のメッセージ')).value,'カスタム入荷通知');
 assert.equal(screen.getByLabelText('メンション先').value,'123456789012345678');
 budgetFailure=true;
 await user.click(screen.getByRole('button',{name:'運用状況'}));
 await user.click(screen.getByRole('button',{name:'仕入れ設定'}));
 assert.match((await screen.findByRole('alert')).textContent,/INVALID_BRIDGE_SIGNATURE/);
 assert.equal(screen.queryByRole('spinbutton'),null,'failed GET must not invent a zero balance or editable allocation');
 assert.equal(errors.length,1);
 budgetFailure=false;zeroBudget=true;
 await user.click(screen.getByRole('button',{name:'仕入れ設定を再取得'}));
 await screen.findByRole('spinbutton',{name:'シャドウバンなしの割合'});
 assert.equal(screen.queryByRole('alert'),null);
 assert.equal(screen.getAllByText('予算残 $0').length,3,'valid zero budgets must render all three categories');

 await user.click(screen.getByRole('button',{name:'履歴と問題'}));
 await screen.findByText('完了');
 assert.ok(screen.getByText('仕入れの注文履歴'));
 cleanup();
 let overviewFailure=true,notices=[];
 globalThis.fetch=async(input)=>{
  const p=new URL(String(input)).pathname;
  if(p.endsWith('/operations/overview'))return overviewFailure?Response.json({message:'bridge unavailable'},{status:503}):Response.json(overview);
  if(p.endsWith('/daily-restock'))return Response.json({config:{}});
  throw new Error('Unexpected request: '+p);
 };
 render(React.createElement(Shiire,{...props,onNotice:m=>notices.push(m)}));
 assert.match((await screen.findByRole('alert')).textContent,/bridge unavailable/);
 assert.ok(screen.getByText('接続エラー'));
 await user.click(screen.getByRole('button',{name:'更新'}));
 await waitFor(()=>assert.equal(screen.getByRole('button',{name:'更新'}).disabled,false));
 assert.deepEqual(notices,[],'failed refresh must not report success');
 overviewFailure=false;
 await user.click(screen.getByRole('button',{name:'再取得'}));
 await screen.findByText('$100');
 assert.equal(screen.queryByRole('alert'),null);
 cleanup();
 let releaseOld;
 const oldResponse=new Promise(resolve=>releaseOld=resolve);
 globalThis.fetch=async(input)=>{
  const p=new URL(String(input)).pathname;
  if(p.includes('/old/')&&p.endsWith('/operations/overview'))return oldResponse;
  if(p.endsWith('/operations/overview'))return Response.json({...overview,balances:{hstora:{ok:true,data:{balance:200,currency:'USD'}}}});
  if(p.endsWith('/daily-restock'))return Response.json({config:{}});
  throw new Error('Unexpected request: '+p);
 };
 const view=render(React.createElement(Shiire,{...props,guildId:'old'}));
 view.rerender(React.createElement(Shiire,{...props,guildId:'new'}));
 await screen.findByText('$200');
 await act(async()=>{releaseOld(Response.json(overview));await oldResponse;});
 assert.ok(screen.getByText('$200'),'old guild response must not overwrite current guild');
 assert.equal(screen.queryByText('$100'),null);
});
