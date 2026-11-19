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
import {vendingSweep,payPayRefreshSweep} from './src/vending';
import {getPayPay} from './src/vending-db';
const SESSION=()=>({accessToken:'saved-access-token',cookies:{token:'web-session-cookie'},expiresAt:Date.now()+7000000,refreshedAt:Date.now()});
const WEB={phone:'test',password:'test',uuid:'11111111-2222-3333-4444-555555555555'};
export default {async fetch(req,env){
 const u=new URL(req.url);
 if(u.pathname==='/init'){await ensureVendingSchema(env);await savePayPay(env,'shared-dashboard','test','test','test',env.SESSION_ENCRYPTION_KEY,SESSION());await saveKyashAccount(env,'shared-dashboard',{email:'test',password:'test',clientUuid:'test',installationUuid:'test',accessToken:'test'});return Response.json({ok:true});}
 if(u.pathname==='/expire'){await cleanVendingExpired(env);return Response.json({ok:true});}
 if(u.pathname==='/sweep'){await vendingSweep(env);return Response.json({ok:true});}
 if(u.pathname==='/paypay') return Response.json(await acceptPayPayLink('test',{phone:'test',password:'test',uuid:'test',session:SESSION()},100));
 if(u.pathname==='/refresh'){await payPayRefreshSweep(env);const a=await getPayPay(env,'shared-dashboard',env.SESSION_ENCRYPTION_KEY);const st=await env.DB.prepare('SELECT paypay_requires_otp,paypay_last_error FROM vending_payment_accounts WHERE user_id=?').bind('shared-dashboard').first();return Response.json({session:a?.session??null,state:st});}
 if(u.pathname==='/seed-session'){const a=await getPayPay(env,'shared-dashboard',env.SESSION_ENCRYPTION_KEY);await a.persistSession(await req.json());return Response.json({ok:true});}
 if(u.pathname==='/paypay-web-text'){const t=await req.text();return Response.json(await acceptPayPayLink(t,{...WEB,session:SESSION()},100));}
 if(u.pathname==='/paypay-web-expired') return Response.json(await acceptPayPayLink('AbCdEf123456',{...WEB,session:{...SESSION(),expiresAt:Date.now()-1000}},100));
 if(u.pathname==='/paypay-web-nosession') return Response.json(await acceptPayPayLink('AbCdEf123456',WEB,100));
 if(u.pathname==='/paypay-web-nocookie') return Response.json(await acceptPayPayLink('AbCdEf123456',{...WEB,session:{...SESSION(),cookies:{}}},100));
 if(u.pathname==='/paypay-web-prefetched'){const info=await (await fetch('https://www.paypay.ne.jp/app/v2/p2p-api/getP2PLinkInfo?verificationCode=AbCdEf123456&client_uuid=x')).json();return Response.json(await acceptPayPayLink('AbCdEf123456',{...WEB,session:SESSION()},100,{linkInfo:info}));}
 if(u.pathname==='/paypay-web') return Response.json(await acceptPayPayLink('https://pay.paypay.ne.jp/AbCdEf123456',{...WEB,session:SESSION()},100));
 if(u.pathname==='/kyash') return Response.json(await receiveKyashLink('test',{clientUuid:'test',installationUuid:'test',accessToken:'test'},100));
 return await handleSupplyBridge(req,env,u)??await handleShiireServiceBridge(req,env,u)??new Response('missing',{status:404});
}};`,resolveDir:process.cwd(),sourcefile:'audit-entry.ts'},bundle:true,write:false,format:'esm',platform:'browser',plugins:process.env.AUDIT_BASELINE?[{name:'baseline',setup(b){b.onLoad({filter:/\/src\/.*\.ts$/},args=>({contents:execFileSync('git',['show','HEAD:'+relative(root,args.path)],{cwd:root,encoding:'utf8'}),loader:'ts'}));}}]:[]});
const instances=[];
after(async()=>{await Promise.all(instances.map(m=>m.dispose()));});
const secret='audit-secret-longer-than-32-characters';
async function fixture(options={}){
 const calls=[];const requests=[];
 const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-08-06',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],bindings:{SESSION_ENCRYPTION_KEY:secret,SHIIRE_BRIDGE_SECRET:secret,WEB_ORIGIN:'https://test.example'},outboundService:async req=>{
  calls.push(req.url);
  requests.push({url:req.url,method:req.method,cookie:req.headers.get('cookie'),referer:req.headers.get('referer'),body:req.method==='POST'?await req.clone().text():null});
  if(req.url.includes('getP2PLinkInfo')){
   if(options.linkStatus)return Response.json({},{status:options.linkStatus});
   const data={amount:options.amount??50};
   if(!options.omitSplit)data.subWalletSplit={
    senderEmoneyAmount:options.money??(options.amount??50),
    senderPrepaidAmount:options.moneyLight??0
   };
   data.orderId='order-1';data.transactionAt='2026-10-29T19:48:00+09:00';data.status=options.status??'PENDING';
   const info={orderId:'order-1',amount:options.amount??50,isSetPasscode:false,isLinkBlocked:options.blocked??false,expiredAt:options.expiredAt??new Date(Date.now()+86400000).toISOString()};
   return Response.json({header:{resultCode:'S0000'},payload:{orderStatus:options.status??'PENDING',pendingP2PInfo:info,sender:{externalId:'sender-1'},receiver:{externalId:options.selfPayment?'sender-1':'receiver-1'},message:{messageId:'msg-1',chatRoomId:'room-1',data}}});
  }
  if(req.url.includes('/oauth/token')){
   if(options.oauth==='otp')return Response.json({otp_reference_id:'ref-1',otp_prefix:'ABCD'},{status:400});
   return new Response(JSON.stringify({access_token:'oauth-access-token',expires_in:86400}),{headers:{'Content-Type':'application/json','Set-Cookie':'token=web-session-cookie; Path=/; HttpOnly; Secure'}});
  }
  if(req.url.includes('acceptP2P')){
   if(options.acceptReply)return Response.json(options.acceptReply.body,{status:options.acceptReply.status??200});
   if(options.acceptStatus)return Response.json({header:{resultCode:'S0001'}},{status:options.acceptStatus});
   return Response.json({header:{resultCode:'S0000'},payload:{orderStatus:'COMPLETED'},error:null});
  }
  if(req.url.includes('kyash.me/payments/'))return new Response('<span class="amountText text_send">'+(options.amount??50)+'</span><a data-href-app="kyash://claim/test">');
  return Response.json({code:200});
 }});instances.push(mf);
 assert.equal((await mf.dispatchFetch('https://test.example/init')).status,200);
 const db=await mf.getD1Database('DB');
 await db.prepare("INSERT INTO vending_machines(id,guild_id,owner_id,name,created_at,updated_at) VALUES ('vm','g','o','test',1,1)").run();
 await db.prepare("INSERT INTO vending_products(id,vending_machine_id,name,description,price_paypay,price_kyash,created_at,updated_at) VALUES ('p','vm','test','',100,100,1,1)").run();
 return {mf,db,calls,requests};
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
 const input={method:'paypay',link:'TestLink123',amount:100,idempotencyKey:'payment-test-123'};
 await signed(mf,'/api/shiire/payment/receive',input);
 await db.prepare("UPDATE shiire_payment_receipts SET status='PENDING' WHERE idempotency_key=?").bind(input.idempotencyKey).run();
 const result=await (await signed(mf,'/api/shiire/payment/receive',input)).json();
 assert.equal(result.ok,false);assert.equal(result.status,'pending');
 assert.equal((await db.prepare("SELECT status FROM shiire_payment_receipts WHERE idempotency_key=?").bind(input.idempotencyKey).first()).status,'PENDING');
});
test('stockless PayPay receipt accepts PayPay Money only',async()=>{
 const {mf,calls}=await fixture({amount:100,money:100,moneyLight:0});
 const input={method:'paypay',link:'MoneyOnlyLink1',amount:100,idempotencyKey:'stockless-money-123',requirePayPayMoney:true};
 const response=await signed(mf,'/api/shiire/payment/receive',input);
 const result=await response.json();
 assert.equal(response.status,200);
 assert.equal(result.ok,true);
 assert.equal(result.status,'completed');
 assert.equal(calls.filter(u=>u.includes('acceptP2P')).length,1);
});
test('stockless PayPay receipt rejects Money Light before acceptance',async()=>{
 const {mf,calls}=await fixture({amount:100,money:0,moneyLight:100});
 const input={method:'paypay',link:'MoneyLightLink1',amount:100,idempotencyKey:'stockless-light-123',requirePayPayMoney:true};
 const response=await signed(mf,'/api/shiire/payment/receive',input);
 const result=await response.json();
 assert.equal(response.status,409);
 assert.equal(result.ok,false);
 assert.equal(result.status,'rejected');
 assert.equal(result.reason,'PAYPAY_MONEY_LIGHT_NOT_ALLOWED');
 assert.equal(calls.some(u=>u.includes('acceptP2P')),false);
});
test('stockless PayPay receipt rejects unknown balance type before acceptance',async()=>{
 const {mf,calls}=await fixture({amount:100,omitSplit:true});
 const input={method:'paypay',link:'UnknownWallet1',amount:100,idempotencyKey:'stockless-unknown-123',requirePayPayMoney:true};
 const response=await signed(mf,'/api/shiire/payment/receive',input);
 const result=await response.json();
 assert.equal(response.status,409);
 assert.equal(result.reason,'PAYPAY_BALANCE_TYPE_UNKNOWN');
 assert.equal(calls.some(u=>u.includes('acceptP2P')),false);
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

test('PayPay Web: link lookup and acceptance use the session cookie and observed payload',async()=>{
 const {mf,requests}=await fixture({amount:100});
 const r=await (await mf.dispatchFetch('https://test.example/paypay-web')).json();
 assert.equal(r.ok,true);assert.equal(r.status,'COMPLETED');
 const info=requests.find(q=>q.url.includes('getP2PLinkInfo'));
 const url=new URL(info.url);
 assert.equal(url.origin+url.pathname,'https://www.paypay.ne.jp/app/v2/p2p-api/getP2PLinkInfo');
 assert.equal(url.searchParams.get('verificationCode'),'AbCdEf123456');
 assert.equal(url.searchParams.get('client_uuid'),'11111111-2222-3333-4444-555555555555');
 assert.equal(info.cookie,'token=web-session-cookie','the saved HttpOnly token cookie is used, not the OAuth token');
 assert.match(info.referer,/^https:\/\/www\.paypay\.ne\.jp\/app\/p2p\/AbCdEf123456\?pid=SMS&link_key=AbCdEf123456/);
 const accept=requests.find(q=>q.url.includes('acceptP2P'));
 assert.equal(accept.url,'https://www.paypay.ne.jp/app/v2/p2p-api/acceptP2PSendMoneyLink');
 assert.equal(accept.cookie,'token=web-session-cookie');
 const body=JSON.parse(accept.body);
 assert.equal(body.requestAt,'2026-10-29T19:48:00+09:00');
 assert.equal(body.orderId,'order-1');
 assert.equal(body.senderChannelUrl,'room-1');
 assert.equal(body.senderMessageId,'msg-1');
 assert.equal(body.verificationCode,'AbCdEf123456');
 assert.equal(body.client_uuid,'11111111-2222-3333-4444-555555555555');
 assert.match(body.requestId,/^[0-9a-f-]{36}$/);
 assert.equal(requests.filter(q=>q.url.includes('/oauth/token')).length,0,'payments never log in');
});
test('PayPay Web: hold codes stay pending and S0000 without COMPLETED is not a payment',async()=>{
 for(const code of ['42007013','42007016']){
  const {mf}=await fixture({amount:100,acceptReply:{status:400,body:{header:{resultCode:code}}}});
  const r=await (await mf.dispatchFetch('https://test.example/paypay-web')).json();
  assert.equal(r.ok,false);assert.equal(r.pending,true);assert.equal(r.status,'TEMPORARY_HOLD');
 }
 const {mf}=await fixture({amount:100,acceptReply:{body:{header:{resultCode:'S0000'},payload:{orderStatus:'PENDING'}}}});
 const r=await (await mf.dispatchFetch('https://test.example/paypay-web')).json();
 assert.equal(r.ok,false);assert.equal(r.pending,true);assert.equal(r.status,'PENDING');
});

test('PayPay Web: link must match the order exactly (reference validate_link_info)',async()=>{
 const cases=[
  [{amount:150},'AMOUNT_MISMATCH'],
  [{amount:100,blocked:true},'BLOCKED_OR_PASSCODE'],
  [{amount:100,selfPayment:true},'SELF_PAYMENT'],
  [{amount:100,expiredAt:'2020-01-01T00:00:00Z'},'EXPIRED']
 ];
 for(const [options,reason] of cases){
  const {mf,calls}=await fixture(options);
  const r=await (await mf.dispatchFetch('https://test.example/paypay-web')).json();
  assert.equal(r.ok,false);assert.equal(r.pending,false);assert.equal(r.status,reason);
  assert.equal(calls.some(u=>u.includes('acceptP2P')),false,reason+' must be rejected before acceptance');
 }
});
test('PayPay Web: copied text with a second URL is rejected, a single link is accepted',async()=>{
 const {mf,calls}=await fixture({amount:100});
 const bad=await (await mf.dispatchFetch('https://test.example/paypay-web-text',{method:'POST',body:'受け取って https://pay.paypay.ne.jp/AbCdEf123456 https://evil.example/x'})).json();
 assert.equal(bad.status,'BAD_LINK');
 assert.equal(calls.some(u=>u.includes('paypay.ne.jp')),false);
 const good=await (await mf.dispatchFetch('https://test.example/paypay-web-text',{method:'POST',body:'PayPayで送金しました https://pay.paypay.ne.jp/AbCdEf123456 。'})).json();
 assert.equal(good.ok,true);
});
test('PayPay Web: session is renewed hourly with the saved UUID and never asks OTP silently',async()=>{
 const {mf,requests}=await fixture();
 const now=Date.now();
 // Fresh session: not due.
 await mf.dispatchFetch('https://test.example/seed-session',{method:'POST',body:JSON.stringify({accessToken:'old-access-token',cookies:{token:'old'},expiresAt:now+7000000,refreshedAt:now})});
 let r=await (await mf.dispatchFetch('https://test.example/refresh')).json();
 assert.equal(r.session.cookies.token,'old');
 assert.equal(requests.filter(q=>q.url.includes('/oauth/token')).length,0);
 // Refreshed more than an hour ago: renewed even though still valid.
 await mf.dispatchFetch('https://test.example/seed-session',{method:'POST',body:JSON.stringify({accessToken:'old-access-token',cookies:{token:'old'},expiresAt:now+3000000,refreshedAt:now-3700000})});
 r=await (await mf.dispatchFetch('https://test.example/refresh')).json();
 assert.equal(r.session.cookies.token,'web-session-cookie');
 assert.ok(r.session.expiresAt-Date.now()<=7200000,'session lifetime is capped at two hours');
 assert.equal(r.state.paypay_last_error,null);
 const login=requests.filter(q=>q.url.includes('/oauth/token'));
 assert.equal(login.length,1);
 assert.equal(JSON.parse(login[0].body).grant_type,'password');
 assert.equal(JSON.parse(login[0].body).client_uuid,'test','the saved client_uuid is reused');
 // Immediately afterwards nothing is due.
 await mf.dispatchFetch('https://test.example/refresh');
 assert.equal(requests.filter(q=>q.url.includes('/oauth/token')).length,1);
});
test('PayPay Web: OTP during renewal is recorded and not retried within the hour',async()=>{
 const {mf,requests}=await fixture({oauth:'otp'});
 await mf.dispatchFetch('https://test.example/seed-session',{method:'POST',body:JSON.stringify({accessToken:'old-access-token',cookies:{token:'old'},expiresAt:Date.now()+3000000,refreshedAt:Date.now()-3700000})});
 let r=await (await mf.dispatchFetch('https://test.example/refresh')).json();
 assert.equal(r.state.paypay_requires_otp,1);
 assert.equal(r.state.paypay_last_error,'otp_required');
 await mf.dispatchFetch('https://test.example/refresh');
 assert.equal(requests.filter(q=>q.url.includes('/oauth/token')).length,1,'no repeated OTP-triggering logins');
 assert.equal(requests.some(q=>q.body&&JSON.parse(q.body).grant_type==='otp'),false,'OTP is never submitted automatically');
});

test('PayPay Web: payments use only the saved session and never log in (reference payment_session_if_valid)',async()=>{
 for(const path of ['/paypay-web-expired','/paypay-web-nosession','/paypay-web-nocookie']){
  const {mf,requests}=await fixture({amount:100});
  const r=await (await mf.dispatchFetch('https://test.example'+path)).json();
  assert.equal(r.ok,false);assert.equal(r.pending,true);assert.equal(r.status,'LOGIN_REQUIRED',path);
  assert.equal(requests.length,0,path+': no PayPay request (no login, no lookup)');
 }
 const {mf,requests}=await fixture({amount:100,acceptStatus:401});
 const r=await (await mf.dispatchFetch('https://test.example/paypay-web')).json();
 assert.equal(r.status,'LOGIN_REQUIRED');
 assert.equal(requests.filter(q=>q.url.includes('acceptP2P')).length,1,'a rejected accept is not retried');
 assert.equal(requests.filter(q=>q.url.includes('/oauth/token')).length,0);
});
test('PayPay Web: a temporary PayPay failure keeps the order pending',async()=>{
 const {mf,requests}=await fixture({amount:100,linkStatus:503});
 const r=await (await mf.dispatchFetch('https://test.example/paypay-web')).json();
 assert.equal(r.ok,false);assert.equal(r.pending,true);assert.equal(r.status,'LINK_UNAVAILABLE');
 assert.equal(requests.some(q=>q.url.includes('acceptP2P')),false);
});
test('PayPay Web: shiire receipt stays retryable when login is missing',async()=>{
 const {mf,db,requests}=await fixture({amount:100});
 await mf.dispatchFetch('https://test.example/seed-session',{method:'POST',body:JSON.stringify({accessToken:'x',cookies:{token:'c'},expiresAt:Date.now()-1000,refreshedAt:0})});
 const input={method:'paypay',link:'RetryLink1234',amount:100,idempotencyKey:'login-retry-123'};
 const first=await (await signed(mf,'/api/shiire/payment/receive',input)).json();
 assert.equal(first.status,'pending');assert.equal(first.reason,'LOGIN_REQUIRED');
 assert.equal(requests.length,0);
 await mf.dispatchFetch('https://test.example/seed-session',{method:'POST',body:JSON.stringify({accessToken:'x',cookies:{token:'web-session-cookie'},expiresAt:Date.now()+7000000,refreshedAt:Date.now()})});
 const second=await (await signed(mf,'/api/shiire/payment/receive',input)).json();
 assert.equal(second.ok,true);assert.equal(second.status,'completed');
 assert.equal((await db.prepare("SELECT status FROM shiire_payment_receipts WHERE idempotency_key=?").bind(input.idempotencyKey).first()).status,'COMPLETED');
});

test('PayPay Web: a lookup made by the caller is reused (one request before the 3s interaction deadline)',async()=>{
 const {mf,requests}=await fixture({amount:100});
 const r=await (await mf.dispatchFetch('https://test.example/paypay-web-prefetched')).json();
 assert.equal(r.ok,true);
 assert.equal(requests.filter(q=>q.url.includes('getP2PLinkInfo')).length,1,'only the caller lookup');
 assert.equal(requests.filter(q=>q.url.includes('acceptP2P')).length,1);
});
