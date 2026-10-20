import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

let shared=null;
async function load(){
 if(shared) return shared;
 const dir=await mkdtemp(path.resolve('.followbomb-ui-test-'));
 await build({entryPoints:['src/FollowBombManager.tsx'],bundle:true,platform:'node',format:'esm',packages:'external',outfile:path.join(dir,'FollowBomb.mjs'),define:{'import.meta.env.VITE_API_BASE_URL':'"https://fixture.example"'},jsx:'automatic'});
 const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'https://fixture.example'});
 for(const key of ['window','document','navigator','HTMLElement','Element','Node','MutationObserver','localStorage','sessionStorage','location','getComputedStyle'])Object.defineProperty(globalThis,key,{value:key==='getComputedStyle'?dom.window.getComputedStyle.bind(dom.window):dom.window[key],configurable:true});
 globalThis.IS_REACT_ACT_ENVIRONMENT=true;
 const React=await import('react');
 const testing=await import('@testing-library/react');
 const {default:userEvent}=await import('@testing-library/user-event');
 const {default:FollowBomb}=await import(pathToFileURL(path.join(dir,'FollowBomb.mjs')).href);
 shared={dir,dom,React,testing,userEvent,FollowBomb,nativeFetch:globalThis.fetch};
 return shared;
}
after(async()=>{
 if(!shared) return;
 shared.testing.cleanup();
 globalThis.fetch=shared.nativeFetch;
 shared.dom.window.close();
 await rm(shared.dir,{recursive:true,force:true});
});

async function setup(t,handler){
 const {React,testing,userEvent,FollowBomb,nativeFetch}=await load();
 t.after(()=>{testing.cleanup();globalThis.fetch=nativeFetch;delete globalThis.confirm;delete globalThis.prompt;});
 const calls=[];
 globalThis.fetch=async(input,init={})=>{
  const url=new URL(String(input));
  const body=init.body?JSON.parse(init.body):null;
  calls.push({path:url.pathname.replace('/api/guilds/fixture/shiire/smm',''),search:url.search,method:init.method??'GET',body});
  const result=await handler(calls.at(-1));
  if(result instanceof Response) return result;
  return Response.json(result);
 };
 const notices=[],errors=[];
 testing.render(React.createElement(FollowBomb,{guildId:'fixture',channels:[{id:'c1',name:'general',type:'text'},{id:'c2',name:'logs',type:'text'}],onNotice:m=>notices.push(m),onError:e=>errors.push(e)}));
 return {...testing,screen:testing.within(document.body),user:userEvent.setup(),calls,notices,errors};
}

const baseOverview=(overrides={})=>({
 configured:true,
 balance:{ok:true,balance:100000,currency:'JPY',currencyOk:true},
 payment:{paypay:true,kyash:false},
 settings:{panel_title:'フォロ爆 自販機',panel_description:'説明',panel_color:5793266,panel_image_url:null,public_log_channel_id:null,private_log_channel_id:null,paused:0,min_margin_percent:0,max_open_orders_per_user:5,min_supplier_balance_jpy:0},
 products:[{id:'p1',name:'X Followers',description:'',emoji:null,service_id:'101',service_name:'X Followers',service_category:'X',markup_percent:30,fee_jpy:0,price_percent:130,min_qty:10,max_qty:0,link_kind:'x_profile',active:1,sales_count:3,live:{found:true,type:'Default',rate:500,min:10,max:10000,refill:true,cancel:false,supported:true},per1000:650,bounds:{min:10,max:10000}}],
 panels:[],
 summary:{byStatus:{hold:{count:1,amount:650}},refundRequired:{count:2,amount:1300}},
 servicesCachedAt:1,
 limits:{panelProductLimit:25},
 ...overrides
});

test('overview shows balance, refund and hold warnings and saves settings',async t=>{
 const f=await setup(t,req=>{
  if(req.path===''&&req.method==='GET') return baseOverview();
  if(req.path==='/settings') return {ok:true,panelsRefreshed:true};
  if(req.path==='/panel') return {ok:true,messageId:'m1'};
  throw new Error('unexpected '+req.method+' '+req.path);
 });
 await f.screen.findByText('¥100,000');
 assert.ok(f.screen.getByText('受付中'));
 assert.ok(f.screen.getByText('2件'));
 assert.ok(f.screen.getByText(/返金対応が必要な注文が 2 件/));
 assert.ok(f.screen.getByText(/確認が必要な注文が 1 件/));
 const margin=f.screen.getByLabelText(/最低利益率/);
 await f.user.clear(margin);await f.user.type(margin,'20');
 await f.user.click(f.screen.getByRole('button',{name:'設定を保存'}));
 await f.waitFor(()=>assert.ok(f.calls.some(c=>c.path==='/settings')));
 const saved=f.calls.find(c=>c.path==='/settings');
 assert.equal(saved.body.min_margin_percent,20);
 assert.equal(saved.body.paused,0);
 await f.user.selectOptions(f.screen.getByLabelText('設置するチャンネル'),'c2');
 await f.user.click(f.screen.getByRole('button',{name:'パネルを設置'}));
 await f.waitFor(()=>assert.ok(f.calls.some(c=>c.path==='/panel')));
 assert.deepEqual(f.calls.find(c=>c.path==='/panel').body,{channelId:'c2'});
 assert.equal(f.errors.length,0);
});

test('a missing API key and non-JPY balance are called out',async t=>{
 const f=await setup(t,req=>{
  if(req.path==='') return baseOverview({configured:false,balance:{ok:false,error:'LUCKYPANEL_API_KEY_NOT_CONFIGURED'}});
  throw new Error('unexpected '+req.path);
 });
 await f.screen.findByText('LuckyPanelのAPIキーが未設定です');
 assert.ok(f.screen.getByText('未設定',{selector:'strong'}));
});

test('a service can be turned into a product and server errors are explained in Japanese',async t=>{
 let rejectOnce=true;
 const services=[
  {service:'101',name:'日本人 Twitter フォロワー',type:'Default',category:'Twitter',rate:500,min:10,max:10000,refill:true,cancel:false,supported:true},
  {service:'202',name:'Twitter カスタムコメント',type:'Custom Comments',category:'Twitter',rate:900,min:10,max:100,refill:false,cancel:false,supported:false},
  {service:'303',name:'Twitter いいね',type:'Default',category:'Twitter',rate:120,min:10,max:5000,refill:false,cancel:false,supported:true}
 ];
 const f=await setup(t,req=>{
  if(req.path==='') return baseOverview();
  if(req.path==='/services') return {services,stale:false,cachedAt:1};
  if(req.path==='/products'&&req.method==='POST'){
   if(rejectOnce){rejectOnce=false;return Response.json({error:'MARGIN_BELOW_FLOOR',message:'MARGIN_BELOW_FLOOR'},{status:400});}
   return {ok:true,panelsRefreshed:true};
  }
  throw new Error('unexpected '+req.method+' '+req.path);
 });
 await f.screen.findByText('¥100,000');
 await f.user.click(f.screen.getByRole('button',{name:'サービスから追加'}));
 await f.screen.findByText(/日本人 Twitter フォロワー/);
 assert.equal(f.screen.queryByText(/カスタムコメント/),null,'unsupported services are hidden by default');
 await f.user.type(f.screen.getByLabelText('検索'),'いいね');
 assert.equal(f.screen.queryByText(/日本人 Twitter フォロワー/),null);
 await f.user.clear(f.screen.getByLabelText('検索'));await f.user.type(f.screen.getByLabelText('検索'),'フォロワー');
 await f.user.click(f.screen.getByRole('button',{name:'商品化'}));
 const dialog=await f.screen.findByRole('dialog',{name:'商品を追加'});
 assert.ok(f.within(dialog).getByText(/販売 ¥650\/1000/));
 await f.user.click(f.within(dialog).getByRole('button',{name:'この内容で追加'}));
 await f.waitFor(()=>assert.equal(f.errors.length,1));
 assert.match(f.errors[0].message,/最低利益率を下回ります/);
 assert.ok(f.screen.getByRole('dialog',{name:'商品を追加'}),'the form stays open after a rejected save');
 await f.user.click(f.within(f.screen.getByRole('dialog',{name:'商品を追加'})).getByRole('button',{name:'この内容で追加'}));
 await f.waitFor(()=>assert.equal(f.notices.length,1));
 const created=f.calls.filter(c=>c.path==='/products'&&c.method==='POST').at(-1).body;
 assert.equal(created.service_id,'101');
 assert.equal(created.link_kind,'x_profile');
 assert.equal(created.price_percent,130);
 assert.equal('fee_jpy' in created,false);
 assert.equal(created.markup_percent,undefined);
 assert.equal(created.emoji,null);
});

test('hold orders need an explicit not-placed confirmation before re-ordering',async t=>{
 const orders=[
  {id:'o1',user_id:'2',product_name:'X Followers',link:'https://x.com/a',quantity:1000,total_amount:650,status:'hold',supplier_order_id:null,supplier_status:null,remains:null,last_error:'PLACING_AMBIGUOUS: 発注が通ったか不明です',refund_state:'none',refund_amount:0,created_at:1,finished_at:null},
  {id:'o2',user_id:'3',product_name:'X Likes',link:'https://x.com/a/status/1',quantity:100,total_amount:100,status:'failed',supplier_order_id:null,supplier_status:null,remains:null,last_error:'LUCKYPANEL_REJECTED:Incorrect link',refund_state:'required',refund_amount:100,created_at:2,finished_at:3}
 ];
 const f=await setup(t,req=>{
  if(req.path==='') return baseOverview();
  if(req.path==='/orders') return {orders,summary:{}};
  if(req.path.endsWith('/action')) return {ok:true};
  throw new Error('unexpected '+req.method+' '+req.path);
 });
 await f.screen.findByText('¥100,000');
 await f.user.click(f.screen.getByRole('button',{name:'注文'}));
 await f.screen.findByText(/要確認 \/ X Followers/);
 globalThis.confirm=()=>false;
 await f.user.click(f.screen.getByRole('button',{name:'未発注を確認して再発注'}));
 assert.equal(f.calls.filter(c=>c.path.endsWith('/action')).length,0,'declining the confirmation sends nothing');
 globalThis.confirm=()=>true;
 await f.user.click(f.screen.getByRole('button',{name:'未発注を確認して再発注'}));
 await f.waitFor(()=>assert.equal(f.calls.filter(c=>c.path==='/orders/o1/action').length,1));
 assert.deepEqual(f.calls.find(c=>c.path==='/orders/o1/action').body,{action:'retry',confirmNotPlaced:true});
 await f.user.click(f.screen.getByRole('button',{name:'返金済みにする'}));
 await f.waitFor(()=>assert.ok(f.calls.some(c=>c.path==='/orders/o2/action')));
 assert.deepEqual(f.calls.find(c=>c.path==='/orders/o2/action').body,{action:'refund_done'});
});
