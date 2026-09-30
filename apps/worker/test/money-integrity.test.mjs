import assert from 'node:assert/strict';
import {test, after} from 'node:test';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {createHmac} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve,relative} from 'node:path';

const root=resolve('../..');
const bundle=await build({stdin:{contents:`
import {ensureVendingSchema,cleanVendingExpired,attachPaymentLink,savePayPay} from './src/vending-db';
import {handleShiireServiceBridge} from './src/shiire-bridge';
import {handleSupplyBridge} from './src/supply-bridge';
import {acceptPayPayLink,receiveKyashLink,saveKyashAccount} from './src/vending-payments';
import {vendingSweep} from './src/vending';
export default {async fetch(req,env){
 const u=new URL(req.url);
 if(u.pathname==='/init'){await ensureVendingSchema(env);await savePayPay(env,'shared-dashboard','test','test','test',env.SESSION_ENCRYPTION_KEY);await saveKyashAccount(env,'shared-dashboard',{email:'test',password:'test',clientUuid:'test',installationUuid:'test',accessToken:'test'});return Response.json({ok:true});}
 if(u.pathname==='/expire'){await cleanVendingExpired(env);return Response.json({ok:true});}
 if(u.pathname==='/sweep'){await vendingSweep(env);return Response.json({ok:true});}
 if(u.pathname==='/paypay') return Response.json(await acceptPayPayLink('test',{phone:'test',password:'test',uuid:'test'},100));
 if(u.pathname==='/kyash') return Response.json(await receiveKyashLink('test',{clientUuid:'test',installationUuid:'test',accessToken:'test'},100));
 return await handleSupplyBridge(req,env,u)??await handleShiireServiceBridge(req,env,u)??new Response('missing',{status:404});
}};`,resolveDir:process.cwd(),sourcefile:'audit-entry.ts'},bundle:true,write:false,format:'esm',platform:'browser',plugins:process.env.AUDIT_BASELINE?[{name:'baseline',setup(b){b.onLoad({filter:/\/src\/.*\.ts$/},args=>({contents:execFileSync('git',['show','HEAD:'+relative(root,args.path)],{cwd:root,encoding:'utf8'}),loader:'ts'}));}}]:[]});
const instances=[];
after(async()=>{await Promise.all(instances.map(m=>m.dispose()));});
const secret='audit-secret-longer-than-32-characters';
async function fixture(options={}){
 const calls=[];
 const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-08-06',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],bindings:{SESSION_ENCRYPTION_KEY:secret,SHIIRE_BRIDGE_SECRET:secret,WEB_ORIGIN:'https://test.example'},outboundService:async req=>{
  calls.push(req.url);
  if(req.url.includes('getP2PLinkInfo'))return Response.json({header:{resultCode:'S0000'},payload:{orderStatus:options.status??'PENDING',message:{data:{amount:options.amount??50}}}});
  if(req.url.includes('/oauth/token'))return Response.json({access_token:'test'});
  if(req.url.includes('acceptP2P'))return Response.json({header:{resultCode:'S0000'}});
  if(req.url.includes('kyash.me/payments/'))return new Response('<span class="amountText text_send">'+(options.amount??50)+'</span><a data-href-app="kyash://claim/test">');
  return Response.json({code:200});
 }});instances.push(mf);
 assert.equal((await mf.dispatchFetch('https://test.example/init')).status,200);
 const db=await mf.getD1Database('DB');
 await db.prepare("INSERT INTO vending_machines(id,guild_id,owner_id,name,created_at,updated_at) VALUES ('vm','g','o','test',1,1)").run();
 await db.prepare("INSERT INTO vending_products(id,vending_machine_id,name,description,price_paypay,price_kyash,created_at,updated_at) VALUES ('p','vm','test','',100,100,1,1)").run();
 return {mf,db,calls};
}
let seq=0;
async function supply(mf,key,items){return signed(mf,'/api/vending/supply/deliver',{productId:'p',idempotencyKey:key,items});}
async function signed(mf,path,payload){
 const body=JSON.stringify(payload);
 const ts=String(Date.now()),nonce='audit_nonce_'+String(++seq).padStart(20,'0');
 const sig=createHmac('sha256',secret).update([ts,nonce,'POST',path,body].join('\n')).digest('hex');
 return mf.dispatchFetch('https://test.example'+path,{method:'POST',body,headers:{'X-Shiire-Timestamp':ts,'X-Shiire-Nonce':nonce,'X-Shiire-Signature':sig}});
}
test('supply receipt failure rolls back stock and fingerprints, retry adds once',async()=>{
 const {mf,db}=await fixture();
 // Initializes the bridge tables with a signed read.
 await supply(mf,'seed',['seed']);
 await db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON vending_supply_receipts WHEN NEW.idempotency_key='failure' BEGIN SELECT RAISE(ABORT,'injected'); END;");
 assert.equal((await supply(mf,'failure',['paid-account'])).status,500);
 assert.equal((await db.prepare("SELECT count(*) n FROM vending_stock WHERE content='paid-account'").first()).n,0);
 await db.exec('DROP TRIGGER fail_receipt;');
 assert.equal((await (await supply(mf,'failure',['paid-account'])).json()).added,1);
 assert.equal((await (await supply(mf,'failure',['paid-account'])).json()).added,1);
 assert.equal((await db.prepare("SELECT count(*) n FROM vending_stock WHERE content='paid-account'").first()).n,1);
});
test('same idempotency key concurrently submitted returns one stable receipt',async()=>{
 const {mf,db}=await fixture();await supply(mf,'seed',['seed']);
 const replies=await Promise.all(Array.from({length:4},()=>supply(mf,'same',['a','b']).then(r=>r.json())));
 for(const r of replies){assert.equal(r.ok,true);assert.equal(r.added,2);}
 assert.equal((await db.prepare("SELECT count(*) n FROM vending_stock WHERE content IN ('a','b')").first()).n,2);
});
test('idempotency payload distinguishes newlines inside individual items',async()=>{
 const {mf}=await fixture();assert.equal((await supply(mf,'different',['a\nb','c'])).status,200);
 assert.equal((await supply(mf,'different',['a','b\nc'])).status,409);
});
test('underpayment is rejected before PayPay acceptance',async()=>{
 const {mf,calls}=await fixture();const r=await (await mf.dispatchFetch('https://test.example/paypay')).json();
 assert.equal(r.ok,false);assert.equal(calls.some(u=>u.includes('acceptP2P')),false);
});
test('underpayment is rejected before Kyash acceptance',async()=>{
 const {mf,calls}=await fixture();const r=await (await mf.dispatchFetch('https://test.example/kyash')).json();
 assert.equal(r.ok,false);assert.equal(calls.some(u=>u.includes('/receive')),false);
});
test('expiration failure leaves reservation intact',async()=>{
 const {mf,db}=await fixture();
 await db.prepare("INSERT INTO vending_orders(id,vending_machine_id,product_id,guild_id,user_id,payment_method,quantity,unit_price,discount_each,total_amount,status,reserved_until,created_at,updated_at) VALUES ('o','vm','p','g','u','paypay',1,100,0,100,'awaiting_payment',1,1,1)").run();
 await db.prepare("INSERT INTO vending_stock(id,product_id,content,state,order_id,reserved_until,created_at) VALUES ('s','p','account','reserved','o',1,1)").run();
 await db.exec("CREATE TRIGGER fail_expire BEFORE UPDATE ON vending_orders WHEN NEW.status='expired' BEGIN SELECT RAISE(ABORT,'injected'); END;");
 assert.equal((await mf.dispatchFetch('https://test.example/expire')).status,500);
 assert.equal((await db.prepare("SELECT state FROM vending_stock WHERE id='s'").first()).state,'reserved');
});

test('consumed PayPay link does not prove seller payment on pending receipt',async()=>{
 const {mf,db}=await fixture({status:'COMPLETED',amount:100});
 const input={method:'paypay',link:'test-link',amount:100,idempotencyKey:'payment-test-123'};
 await signed(mf,'/api/shiire/payment/receive',input);
 await db.prepare("UPDATE shiire_payment_receipts SET status='PENDING' WHERE idempotency_key=?").bind(input.idempotencyKey).run();
 const result=await (await signed(mf,'/api/shiire/payment/receive',input)).json();
 assert.equal(result.ok,false);assert.equal(result.status,'pending');
 assert.equal((await db.prepare("SELECT status FROM shiire_payment_receipts WHERE idempotency_key=?").bind(input.idempotencyKey).first()).status,'PENDING');
});
test('pending Kyash receipt survives temporarily unavailable link',async()=>{
 const {mf,db}=await fixture();
 const input={method:'kyash',link:'test-link',amount:100,idempotencyKey:'payment-test-456'};
 await signed(mf,'/api/shiire/payment/receive',input);
 await db.prepare("UPDATE shiire_payment_receipts SET status='PENDING' WHERE idempotency_key=?").bind(input.idempotencyKey).run();
 const result=await (await signed(mf,'/api/shiire/payment/receive',input)).json();
 assert.equal(result.ok,false);assert.equal(result.status,'pending');
});

test('successful Kyash receipt retry keeps the same normalized completion status',async()=>{
 const {mf,calls}=await fixture({amount:100});
 const input={method:'kyash',link:'test-link-success',amount:100,idempotencyKey:'kyash-success-123'};
 const first=await (await signed(mf,'/api/shiire/payment/receive',input)).json();
 const again=await (await signed(mf,'/api/shiire/payment/receive',input)).json();
 assert.equal(first.status,'completed');assert.equal(again.status,'completed');assert.equal(again.ok,true);
 assert.equal(calls.filter(u=>u.includes('/receive')).length,1);
});
