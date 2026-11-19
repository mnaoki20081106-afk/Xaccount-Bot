import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';

// 旧仕入れbot自販機の廃止: products move to the 「X垢」 machine, HSTORA items get
// their destination, and only then the old machines (and panels) are deleted.

const G='123456789012345678';
const bundle=await build({stdin:{contents:`
import {createDashboardSession} from './src/db';
import {sha256Hex} from './src/utils';
import {ensureVendingSchema} from './src/vending-db';
import {handleShiireDashboardProxy} from './src/shiire-bridge';
export default {async fetch(request,env){
 if(new URL(request.url).pathname==='/fixture-session'){
  await ensureVendingSchema(env);
  await createDashboardSession(env,await sha256Hex('fixture-session'),Date.now()+60000);
  return Response.json({ok:true});
 }
 return await handleShiireDashboardProxy(request,env,new URL(request.url))??new Response('missing',{status:404});
}};`,resolveDir:process.cwd(),sourcefile:'shiire-retire-fixture.ts'},bundle:true,write:false,format:'esm',platform:'browser'});

async function fixture(t,options={}){
 const shiire={
  machines:[{id:'sm1',name:'仕入れ自販機',products:[
   {id:'a',name:'①即反映100%シャドバンなしX垢',description:'説明1',price_paypay:300,price_kyash:310,emoji:'🐔',procurement_class:'NO_SHADOWBAN'},
   {id:'b',name:'② 即反映100%検索に載るシャドバンなしOLD垢',description:'説明2',price_paypay:500,price_kyash:520,emoji:null,procurement_class:'TOP_SEARCH'}
  ],panels:[{channel_id:'1',message_id:'2'}]}],
  items:[
   {id:'hstora-top_search',name:'検索上位',template:'hstora',condition:{class:'TOP_SEARCH'},mainProductId:null},
   {id:'hstora-no_shadowban',name:'シャドバンなし',template:'hstora',condition:{class:'NO_SHADOWBAN'},mainProductId:options.preset??null}
  ],
  patches:[],deleted:[]
 };
 const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-08-06',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],
  bindings:{DISCORD_BOT_TOKEN:'fixture',SHIIRE_API_BASE_URL:'https://shiire.example',SHIIRE_BRIDGE_SECRET:'fixture-secret-at-least-32-characters'},
  outboundService:async request=>{
   const url=new URL(request.url);
   if(url.hostname==='discord.com') return Response.json({id:G});
   const path=url.pathname.replace('/bridge/main/guilds/'+G,'');
   if(path==='/vending'&&request.method==='GET') return Response.json(shiire.machines);
   if(path==='/procurement'&&request.method==='GET') return Response.json({items:shiire.items});
   const item=path.match(/^\/procurement\/items\/([^/]+)$/);
   if(item&&request.method==='PATCH'){
    const body=await request.json();shiire.patches.push({id:decodeURIComponent(item[1]),...body});
    shiire.items.find(i=>i.id===decodeURIComponent(item[1])).mainProductId=body.mainProductId;
    return Response.json({ok:true});
   }
   const machine=path.match(/^\/vending\/([^/]+)$/);
   if(machine&&request.method==='DELETE'){
    if(options.deleteFails) return Response.json({message:'open orders'},{status:409});
    shiire.deleted.push(machine[1]);shiire.machines=shiire.machines.filter(m=>m.id!==machine[1]);
    return Response.json({ok:true,panelErrors:[]});
   }
   return Response.json({error:'unexpected '+request.method+' '+path},{status:500});
  }});
 t.after(()=>mf.dispose());
 await mf.dispatchFetch('https://api.example/fixture-session');
 const db=await mf.getD1Database('DB');
 const retire=async()=>{const r=await mf.dispatchFetch('https://api.example/api/guilds/'+G+'/shiire/retire-vending',{method:'POST',headers:{Authorization:'Bearer fixture-session'}});return {status:r.status,body:await r.json()};};
 const addMachine=(id,name)=>db.prepare("INSERT INTO vending_machines(id,guild_id,owner_id,name,active,created_at,updated_at) VALUES (?,?,?,?,1,1,1)").bind(id,G,'o',name).run();
 return {shiire,db,retire,addMachine};
}

test('retire needs exactly one 「X垢」 machine and changes nothing otherwise',async t=>{
 const {shiire,retire,addMachine}=await fixture(t);
 let r=await retire();
 assert.equal(r.status,409);assert.equal(r.body.error,'TARGET_MACHINE_NOT_FOUND');
 await addMachine('x1','X垢');await addMachine('x2','X垢');
 r=await retire();
 assert.equal(r.body.error,'TARGET_MACHINE_AMBIGUOUS');
 assert.equal(shiire.deleted.length,0);assert.equal(shiire.patches.length,0);
});

test('retire copies the products, sets destinations by class, then deletes the old machine; a rerun creates nothing new',async t=>{
 const {shiire,db,retire,addMachine}=await fixture(t,{preset:'keep-me'});
 await addMachine('x1','X垢');
 const r=await retire();
 assert.equal(r.status,200,JSON.stringify(r.body));
 assert.deepEqual(r.body.created,['①即反映100%シャドバンなしX垢','② 即反映100%検索に載るシャドバンなしOLD垢']);
 const products=(await db.prepare("SELECT id,name,description,price_paypay,price_kyash,emoji,infinite_stock FROM vending_products WHERE vending_machine_id='x1' ORDER BY sort_order").all()).results;
 assert.deepEqual(products.map(p=>[p.name,p.description,p.price_paypay,p.price_kyash,p.emoji,p.infinite_stock]),[
  ['①即反映100%シャドバンなしX垢','説明1',300,310,'🐔',0],
  ['② 即反映100%検索に載るシャドバンなしOLD垢','説明2',500,520,null,0]
 ]);
 const top=products.find(p=>p.name.startsWith('②'));
 assert.deepEqual(shiire.patches,[{id:'hstora-top_search',mainProductId:top.id}],'an item that already has a destination is left alone, nothing is enabled');
 assert.deepEqual(shiire.deleted,['sm1']);
 const again=await retire();
 assert.equal(again.status,200);
 assert.deepEqual(again.body.created,[]);
 assert.equal((await db.prepare("SELECT count(*) n FROM vending_products WHERE vending_machine_id='x1'").first()).n,2);
});

test('when deleting the old machine fails, the error is reported and a rerun reuses the products',async t=>{
 const {shiire,db,retire,addMachine}=await fixture(t,{deleteFails:true});
 await addMachine('x1','X垢');
 const r=await retire();
 assert.equal(r.status,502);
 assert.match(r.body.message,/open orders/);
 const rerun=await retire();
 assert.deepEqual(rerun.body.created??[],[]);
 assert.equal((await db.prepare("SELECT count(*) n FROM vending_products WHERE vending_machine_id='x1'").first()).n,2);
 assert.equal(shiire.machines.length,1);
});
