import type { Env } from "./types";
import { botJson } from "./discord";
import { getDashboardSession } from "./db";
import {
  ensureVendingSchema,
  getPayPay
} from "./vending-db";
import {
  acceptPayPayLink,
  checkPayPayLink,
  checkKyashLink,
  getKyashAccount,
  receiveKyashLink
} from "./vending-payments";
import { json, randomId, sha256Hex, withCors } from "./utils";

const MAX_CLOCK_SKEW_MS=5*60_000;
const OWNER_ID="shared-dashboard";
let bridgeSchemaReady=false;

async function ensureBridgeSchema(env:Env){
  if(bridgeSchemaReady) return;
  await ensureVendingSchema(env);
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS shiire_bridge_nonces ("+
    "nonce TEXT PRIMARY KEY,expires_at INTEGER NOT NULL)"
  ).run();
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS shiire_payment_receipts ("+
    "idempotency_key TEXT PRIMARY KEY,method TEXT NOT NULL,link_hash TEXT NOT NULL UNIQUE,"+
    "amount INTEGER NOT NULL,status TEXT NOT NULL,response_json TEXT NOT NULL DEFAULT '{}',"+
    "created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"
  ).run();
  bridgeSchemaReady=true;
}

function shiireBaseUrl(env:Env):URL{
  const raw=env.SHIIRE_API_BASE_URL?.trim()??"";
  if(!raw) throw new Error("SHIIRE_API_BASE_URL_NOT_CONFIGURED");
  let url:URL;
  try{url=new URL(raw);}
  catch{throw new Error("SHIIRE_API_BASE_URL_INVALID");}
  if(
    url.protocol!=="https:"||
    url.username||
    url.password||
    url.search||
    url.hash||
    (url.pathname!=="/"&&url.pathname!=="")
  ){
    throw new Error("SHIIRE_API_BASE_URL_MUST_BE_HTTPS_ORIGIN");
  }
  return new URL(url.origin+"/");
}

async function sign(
  secret:string,
  canonical:string
):Promise<string>{
  const key=await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    {name:"HMAC",hash:"SHA-256"},
    false,
    ["sign"]
  );
  const signature=await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(canonical)
  );
  return [...new Uint8Array(signature)]
    .map(value=>value.toString(16).padStart(2,"0"))
    .join("");
}

async function signedShiireFetch(
  env:Env,
  path:string,
  init:RequestInit={}
):Promise<Response>{
  const secret=env.SHIIRE_BRIDGE_SECRET?.trim()??"";
  if(secret.length<32) throw new Error("SHIIRE_BRIDGE_SECRET_NOT_CONFIGURED");
  const url=new URL(path.replace(/^\//,""),shiireBaseUrl(env));
  const method=String(init.method??"GET").toUpperCase();
  const body=typeof init.body==="string"?init.body:"";
  const timestamp=String(Date.now());
  const nonce=randomId();
  const canonical=
    timestamp+"\n"+
    nonce+"\n"+
    method+"\n"+
    url.pathname+url.search+"\n"+
    body;
  const signature=await sign(secret,canonical);
  const headers=new Headers(init.headers);
  headers.set("X-Shiire-Timestamp",timestamp);
  headers.set("X-Shiire-Nonce",nonce);
  headers.set("X-Shiire-Signature",signature);
  if(body&&!headers.has("Content-Type")) headers.set("Content-Type","application/json");
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),20_000);
  try{
    return await fetch(url.toString(),{
      ...init,
      method,
      body:body||undefined,
      headers,
      signal:controller.signal
    });
  }finally{
    clearTimeout(timer);
  }
}

async function requireDashboardSession(request:Request,env:Env){
  const auth=request.headers.get("Authorization");
  if(!auth?.startsWith("Bearer ")) throw new Error("DASHBOARD_LOGIN_REQUIRED");
  const token=auth.slice(7).trim();
  const row=await getDashboardSession(env,await sha256Hex(token));
  if(!row) throw new Error("DASHBOARD_SESSION_EXPIRED");
}

export async function handleShiireDashboardProxy(
  request:Request,
  env:Env,
  url:URL
):Promise<Response|null>{
  const match=url.pathname.match(/^\/api\/guilds\/(\d+)\/shiire(\/.*)?$/);
  if(!match) return null;
  await requireDashboardSession(request,env);
  const guildId=match[1]!;
  await botJson(env,"/guilds/"+guildId);
  const suffix=match[2]??"";
  const target="/bridge/main/guilds/"+guildId+suffix+url.search;
  const body=["GET","HEAD"].includes(request.method)?"":await request.text();
  try{
    const response=await signedShiireFetch(env,target,{
      method:request.method,
      body:body||undefined
    });
    const text=await response.text();
    return withCors(env,new Response(text,{
      status:response.status,
      headers:{
        "Content-Type":response.headers.get("Content-Type")??"application/json; charset=utf-8",
        "Cache-Control":"no-store"
      }
    }));
  }catch(error){
    const message=error instanceof Error?error.message:String(error);
    if(message==="SHIIRE_API_BASE_URL_NOT_CONFIGURED"){
      return json(env,{
        error:"SHIIRE_API_BASE_URL_NOT_CONFIGURED",
        message:"Discord-Shiire Workerの実URLをSHIIRE_API_BASE_URLへ設定してください。推測URLでは接続しません。"
      },503);
    }
    if(
      message==="SHIIRE_API_BASE_URL_INVALID"||
      message==="SHIIRE_API_BASE_URL_MUST_BE_HTTPS_ORIGIN"
    ){
      return json(env,{
        error:message,
        message:"SHIIRE_API_BASE_URLには https://host のWorker originだけを設定してください。パス・クエリ・認証情報は付けません。"
      },503);
    }
    if(message==="SHIIRE_BRIDGE_SECRET_NOT_CONFIGURED"){
      return json(env,{
        error:"SHIIRE_BRIDGE_SECRET_NOT_CONFIGURED",
        message:"Xaccount-BotとDiscord-Shiireの両方へ同じSHIIRE_BRIDGE_SECRETを設定してください。"
      },503);
    }
    return json(env,{
      error:"SHIIRE_BRIDGE_UNREACHABLE",
      message:"Discord-Shiireへ接続できません: "+message.slice(0,180)
    },502);
  }
}

function hexBytes(value:string):Uint8Array|null{
  if(!/^[0-9a-f]{64}$/i.test(value)) return null;
  const out=new Uint8Array(value.length/2);
  for(let i=0;i<out.length;i++) out[i]=parseInt(value.slice(i*2,i*2+2),16);
  return out;
}

async function verifyShiireSignedRequest(
  request:Request,
  env:Env,
  url:URL,
  body:string
){
  const secret=env.SHIIRE_BRIDGE_SECRET?.trim()??"";
  if(secret.length<32) throw new Error("SHIIRE_BRIDGE_SECRET_NOT_CONFIGURED");
  const timestamp=request.headers.get("X-Shiire-Timestamp")?.trim()??"";
  const nonce=request.headers.get("X-Shiire-Nonce")?.trim()??"";
  const signature=request.headers.get("X-Shiire-Signature")?.trim()??"";
  const ts=Number(timestamp);
  if(!/^\d{10,16}$/.test(timestamp)||!Number.isFinite(ts)) throw new Error("INVALID_TIMESTAMP");
  if(Math.abs(Date.now()-ts)>MAX_CLOCK_SKEW_MS) throw new Error("STALE_TIMESTAMP");
  if(!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) throw new Error("INVALID_NONCE");
  const sig=hexBytes(signature);
  if(!sig) throw new Error("INVALID_SIGNATURE");
  const canonical=
    timestamp+"\n"+
    nonce+"\n"+
    request.method.toUpperCase()+"\n"+
    url.pathname+url.search+"\n"+
    body;
  const key=await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    {name:"HMAC",hash:"SHA-256"},
    false,
    ["verify"]
  );
  const valid=await crypto.subtle.verify(
    "HMAC",
    key,
    sig.buffer as ArrayBuffer,
    new TextEncoder().encode(canonical)
  );
  if(!valid) throw new Error("INVALID_SIGNATURE");
  await ensureBridgeSchema(env);
  const now=Date.now();
  await env.DB.prepare("DELETE FROM shiire_bridge_nonces WHERE expires_at<?").bind(now).run();
  try{
    await env.DB.prepare(
      "INSERT INTO shiire_bridge_nonces(nonce,expires_at) VALUES (?,?)"
    ).bind(nonce,now+MAX_CLOCK_SKEW_MS).run();
  }catch{
    throw new Error("REPLAYED_NONCE");
  }
}

async function reservePaymentReceipt(
  env:Env,
  input:{
    idempotencyKey:string;
    method:"paypay"|"kyash";
    linkHash:string;
    amount:number;
  }
){
  const claimOrderId="shiire:"+input.idempotencyKey;
  const existing=await env.DB.prepare(
    "SELECT * FROM shiire_payment_receipts WHERE idempotency_key=?"
  ).bind(input.idempotencyKey).first<any>();
  if(existing){
    if(
      existing.method!==input.method||
      existing.link_hash!==input.linkHash||
      Number(existing.amount)!==input.amount
    ) throw new Error("IDEMPOTENCY_CONFLICT");
    const existingClaim=await env.DB.prepare(
      "SELECT order_id FROM vending_used_payment_links WHERE link_hash=?"
    ).bind(input.linkHash).first<{order_id:string}>();
    if(existingClaim&&existingClaim.order_id!==claimOrderId){
      throw new Error("PAYMENT_LINK_ALREADY_USED");
    }
    if(!existingClaim){
      try{
        await env.DB.prepare(
          "INSERT INTO vending_used_payment_links(link_hash,provider,order_id,used_at) VALUES (?, 'shiire_pending', ?, ?)"
        ).bind(input.linkHash,claimOrderId,Date.now()).run();
      }catch{
        const raced=await env.DB.prepare(
          "SELECT order_id FROM vending_used_payment_links WHERE link_hash=?"
        ).bind(input.linkHash).first<{order_id:string}>();
        if(!raced||raced.order_id!==claimOrderId){
          throw new Error("PAYMENT_LINK_ALREADY_USED");
        }
      }
    }
    return existing;
  }

  const sameLink=await env.DB.prepare(
    "SELECT idempotency_key FROM shiire_payment_receipts WHERE link_hash=?"
  ).bind(input.linkHash).first<{idempotency_key:string}>();
  if(sameLink&&sameLink.idempotency_key!==input.idempotencyKey){
    throw new Error("PAYMENT_LINK_ALREADY_USED");
  }

  const used=await env.DB.prepare(
    "SELECT order_id FROM vending_used_payment_links WHERE link_hash=?"
  ).bind(input.linkHash).first<{order_id:string}>();
  if(used&&used.order_id!==claimOrderId){
    throw new Error("PAYMENT_LINK_ALREADY_USED");
  }
  if(!used){
    try{
      await env.DB.prepare(
        "INSERT INTO vending_used_payment_links(link_hash,provider,order_id,used_at) VALUES (?, 'shiire_pending', ?, ?)"
      ).bind(input.linkHash,claimOrderId,Date.now()).run();
    }catch{
      const raced=await env.DB.prepare(
        "SELECT order_id FROM vending_used_payment_links WHERE link_hash=?"
      ).bind(input.linkHash).first<{order_id:string}>();
      if(!raced||raced.order_id!==claimOrderId){
        throw new Error("PAYMENT_LINK_ALREADY_USED");
      }
    }
  }

  const now=Date.now();
  await env.DB.prepare(
    "INSERT INTO shiire_payment_receipts("+
    "idempotency_key,method,link_hash,amount,status,response_json,created_at,updated_at"+
    ") VALUES (?,?,?,?,?,'{}',?,?)"
  ).bind(
    input.idempotencyKey,input.method,input.linkHash,input.amount,"PROCESSING",now,now
  ).run();
  return env.DB.prepare(
    "SELECT * FROM shiire_payment_receipts WHERE idempotency_key=?"
  ).bind(input.idempotencyKey).first<any>();
}

async function finishPaymentReceipt(
  env:Env,
  idempotencyKey:string,
  status:string,
  response:unknown
){
  await env.DB.prepare(
    "UPDATE shiire_payment_receipts SET status=?,response_json=?,updated_at=? "+
    "WHERE idempotency_key=?"
  ).bind(status,JSON.stringify(response),Date.now(),idempotencyKey).run();
}

async function recordUsedLink(
  env:Env,
  method:string,
  idempotencyKey:string,
  linkHash:string
){
  const orderId="shiire:"+idempotencyKey;
  const now=Date.now();
  const existing=await env.DB.prepare(
    "SELECT order_id FROM vending_used_payment_links WHERE link_hash=?"
  ).bind(linkHash).first<{order_id:string}>();
  if(existing&&existing.order_id!==orderId){
    throw new Error("PAYMENT_LINK_ALREADY_USED");
  }
  if(existing){
    await env.DB.prepare(
      "UPDATE vending_used_payment_links SET provider=?,used_at=? WHERE link_hash=? AND order_id=?"
    ).bind("shiire_"+method,now,linkHash,orderId).run();
  }else{
    await env.DB.prepare(
      "INSERT INTO vending_used_payment_links(link_hash,provider,order_id,used_at) VALUES (?,?,?,?)"
    ).bind(linkHash,"shiire_"+method,orderId,now).run();
  }
}

function bridgeError(env:Env,error:unknown):Response{
  const code=error instanceof Error?error.message:String(error);
  const authCodes=new Set([
    "INVALID_TIMESTAMP","STALE_TIMESTAMP","INVALID_NONCE","INVALID_SIGNATURE","REPLAYED_NONCE"
  ]);
  const status=
    code==="SHIIRE_BRIDGE_SECRET_NOT_CONFIGURED"?503:
    authCodes.has(code)?401:
    code==="IDEMPOTENCY_CONFLICT"||code==="PAYMENT_LINK_ALREADY_USED"?409:
    code.endsWith("_NOT_CONFIGURED")?503:
    400;
  return json(env,{error:code},status);
}

export async function handleShiireServiceBridge(
  request:Request,
  env:Env,
  url:URL
):Promise<Response|null>{
  if(!url.pathname.startsWith("/api/shiire/")) return null;
  const body=["GET","HEAD"].includes(request.method)?"":await request.text();
  try{
    await verifyShiireSignedRequest(request,env,url,body);

    if(url.pathname==="/api/shiire/payment/status"&&request.method==="GET"){
      const [paypay,kyash]=await Promise.all([
        getPayPay(env,OWNER_ID,env.SESSION_ENCRYPTION_KEY),
        getKyashAccount(env,OWNER_ID)
      ]);
      return json(env,{paypay:Boolean(paypay),kyash:Boolean(kyash)});
    }

    if(url.pathname==="/api/shiire/payment/receive"&&request.method==="POST"){
      let input:{
        method?:"paypay"|"kyash";
        link?:string;
        amount?:number;
        idempotencyKey?:string;
      };
      try{input=JSON.parse(body) as typeof input;}
      catch{return json(env,{error:"INVALID_JSON"},400);}
      const method=input.method;
      const link=String(input.link??"").trim();
      const amount=Number(input.amount);
      const idempotencyKey=String(input.idempotencyKey??"").trim();
      if(
        (method!=="paypay"&&method!=="kyash")||
        !link||
        link.length>1000||
        !Number.isSafeInteger(amount)||
        amount<=0||
        !/^[A-Za-z0-9:_-]{8,160}$/.test(idempotencyKey)
      ){
        return json(env,{error:"INVALID_PAYMENT_REQUEST"},400);
      }
      const linkHash=await sha256Hex(link);
      const receipt=await reservePaymentReceipt(env,{
        idempotencyKey,method,linkHash,amount
      });
      if(receipt?.status==="COMPLETED"){
        let response:any={};
        try{response=JSON.parse(receipt.response_json??"{}");}catch{}
        return json(env,{...response,ok:true,status:"completed",duplicate:true});
      }
      const wasPending=receipt?.status==="PENDING";
      // A previous request may have accepted money before losing its response.
      // Do not turn an unavailable/consumed link into a rejected order.
      let previousResult:any={};
      try{previousResult=JSON.parse(receipt?.response_json??"{}");}catch{}
      const retryLogin=wasPending&&previousResult.status==="LOGIN_REQUIRED";
      if(wasPending&&!retryLogin){
        return json(env,{ok:false,status:"pending",reason:"PAYMENT_RESULT_REQUIRES_RECONCILIATION"},202);
      }
      const claim=await env.DB.prepare(
        "UPDATE shiire_payment_receipts SET status='PENDING',response_json='{\"stage\":\"ACCEPT_CLAIMED\"}',updated_at=? WHERE idempotency_key=? AND status=? AND response_json=?"
      ).bind(Date.now(),idempotencyKey,receipt.status,receipt.response_json).run();
      if((claim.meta.changes??0)!==1){
        return json(env,{ok:false,status:"pending"},202);
      }

      if(method==="paypay"){
        const account=await getPayPay(env,OWNER_ID,env.SESSION_ENCRYPTION_KEY);
        if(!account){
          await finishPaymentReceipt(env,idempotencyKey,"REJECTED",{reason:"PAYPAY_NOT_CONFIGURED"});
          return json(env,{error:"PAYPAY_NOT_CONFIGURED"},409);
        }
        const info=await checkPayPayLink(link);
        const linkAmount=Number(info?.payload?.message?.data?.amount??0);
        const currentStatus=String(info?.payload?.orderStatus??"");
        if(!info||!Number.isFinite(linkAmount)||linkAmount<amount){
          await finishPaymentReceipt(env,idempotencyKey,"REJECTED",{linkAmount});
          return json(env,{error:"PAYPAY_AMOUNT_INSUFFICIENT",linkAmount,required:amount},409);
        }
        if(currentStatus==="SUCCESS"||currentStatus==="COMPLETED"){
          if(!wasPending){
            await finishPaymentReceipt(env,idempotencyKey,"REJECTED",{
              amount:linkAmount,
              reason:"PAYPAY_LINK_ALREADY_COMPLETED"
            });
            return json(env,{
              error:"PAYPAY_LINK_ALREADY_COMPLETED",
              linkAmount,
              required:amount
            },409);
          }
          // The public link may have been accepted by a different recipient.
          return json(env,{ok:false,status:"pending",amount:linkAmount,
            reason:"PAYPAY_RECIPIENT_UNVERIFIED"},202);
        }
        await finishPaymentReceipt(env,idempotencyKey,"PENDING",{
          stage:"PAYPAY_ACCEPT_SUBMITTED",
          amount:linkAmount
        });
        const result=await acceptPayPayLink(link,account,amount);
        if(result.ok){
          await finishPaymentReceipt(env,idempotencyKey,"COMPLETED",{amount:result.amount});
          await recordUsedLink(env,method,idempotencyKey,linkHash).catch(error=>
            console.error("shiire paypay used-link audit write failed",idempotencyKey,error)
          );
          return json(env,{ok:true,status:"completed",amount:result.amount});
        }
        if(result.pending){
          await finishPaymentReceipt(env,idempotencyKey,"PENDING",result);
          return json(env,{ok:false,status:"pending",amount:result.amount});
        }
        await finishPaymentReceipt(env,idempotencyKey,"REJECTED",result);
        return json(env,{ok:false,status:"rejected",amount:result.amount,reason:result.status},409);
      }

      const account=await getKyashAccount(env,OWNER_ID);
      if(!account){
        await finishPaymentReceipt(env,idempotencyKey,"REJECTED",{reason:"KYASH_NOT_CONFIGURED"});
        return json(env,{error:"KYASH_NOT_CONFIGURED"},409);
      }
      const kyashInfo=await checkKyashLink(link);
      if(!kyashInfo){
        await finishPaymentReceipt(env,idempotencyKey,"REJECTED",{
          reason:"KYASH_LINK_INVALID"
        });
        return json(env,{error:"KYASH_LINK_INVALID"},409);
      }
      if(kyashInfo.amount<amount){
        await finishPaymentReceipt(env,idempotencyKey,"REJECTED",{
          linkAmount:kyashInfo.amount,
          required:amount
        });
        return json(env,{
          error:"KYASH_AMOUNT_INSUFFICIENT",
          linkAmount:kyashInfo.amount,
          required:amount
        },409);
      }
      await finishPaymentReceipt(env,idempotencyKey,"PENDING",{
        stage:"KYASH_RECEIVE_SUBMITTED",
        amount:kyashInfo.amount
      });
      const result=await receiveKyashLink(link,account,amount);
      if(result.ok){
        await finishPaymentReceipt(env,idempotencyKey,"COMPLETED",result);
        await recordUsedLink(env,method,idempotencyKey,linkHash).catch(error=>
          console.error("shiire kyash used-link audit write failed",idempotencyKey,error)
        );
        return json(env,{ok:true,status:"completed",amount:result.amount});
      }
      if(wasPending||result.pending){
        await finishPaymentReceipt(env,idempotencyKey,"PENDING",{
          ...result,
          reason:"AMBIGUOUS_PREVIOUS_KYASH_RECEIVE"
        });
        return json(env,{
          ok:false,
          status:"pending",
          amount:result.amount,
          reason:"AMBIGUOUS_PREVIOUS_KYASH_RECEIVE"
        },202);
      }
      if(result.amount<amount&&result.amount>0){
        await finishPaymentReceipt(env,idempotencyKey,"REJECTED",result);
        return json(env,{error:"KYASH_AMOUNT_INSUFFICIENT",linkAmount:result.amount,required:amount},409);
      }
      await finishPaymentReceipt(env,idempotencyKey,"REJECTED",result);
      return json(env,{ok:false,status:"rejected",amount:result.amount},409);
    }

    return json(env,{error:"NOT_FOUND"},404);
  }catch(error){
    return bridgeError(env,error);
  }
}
