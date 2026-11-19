import type { Env } from "./types";
import { decrypt, encrypt, randomId } from "./utils";

// ---------------------------------------------------------------------------
// PayPay Web (www.paypay.ne.jp) — request format follows the owner-supplied
// browser implementation (paypayu.py / paypaython_web_mobile.py, 2026-10-29):
//   POST /app/v1/oauth/token                    password / otp login
//   GET  /app/v2/p2p-api/getP2PLinkInfo         verificationCode + client_uuid, `token` cookie
//   POST /app/v2/p2p-api/acceptP2PSendMoneyLink `token` cookie
// Not an official API. Never log credentials, cookies, tokens or link codes.
// ---------------------------------------------------------------------------

const PAYPAY_ORIGIN="https://www.paypay.ne.jp";
export const PAYPAY_TOKEN_ENDPOINT=PAYPAY_ORIGIN+"/app/v1/oauth/token";
export const PAYPAY_LINK_INFO_ENDPOINT=PAYPAY_ORIGIN+"/app/v2/p2p-api/getP2PLinkInfo";
export const PAYPAY_LINK_ACCEPT_ENDPOINT=PAYPAY_ORIGIN+"/app/v2/p2p-api/acceptP2PSendMoneyLink";
const PAYPAY_SIGN_IN_REFERER=PAYPAY_ORIGIN+"/app/account/sign-in";
const PAYPAY_UA=
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) "+
  "AppleWebKit/605.1.15 (KHTML, like Gecko) "+
  "Version/18.0 Mobile/15E148 Safari/604.1";
// The browser token's expires_in can be ~24h, but the usable Web session lasts
// about two hours; use the shorter bound like the reference implementation.
const PAYPAY_SESSION_MAX_MS=7200_000;
const KYASH_VERSION="11.8.1";

// Provider codes that mean "received but temporarily held" (受け取り保留).
export const PAYPAY_HOLD_CODES=new Set(["42007013","42007014","42007015","42007016"]);
export const PAYPAY_HOLD_NOTICE=
  "PayPay側で一時保留になっている可能性があります。"+
  "PayPayアプリで送金の状態を確認し、解除操作が表示される場合は解除してください。"+
  "解除後は販売者側で受取状況を再確認します。"+
  "確認が終わるまで、同じリンクを再送したり新しい送金をしたりしないでください。";

function payPayHeaders(referer:string,extra?:Record<string,string>){
  return {
    "Accept":"application/json, text/plain, */*",
    "Accept-Language":"ja,en-US;q=0.9,en;q=0.8",
    "Origin":PAYPAY_ORIGIN,
    "Referer":referer,
    "User-Agent":PAYPAY_UA,
    "Content-Type":"application/json",
    ...(extra??{})
  };
}

function payPayLinkReferer(code:string){
  return PAYPAY_ORIGIN+"/app/p2p/"+code+
    "?pid=SMS&link_key="+code+
    "&af_dp=paypay%3A%2F%2Fpending%2Fdetail%3Fsource%3Dsns_link";
}

function payCode(link:string){
  return link.trim().replace(/^https:\/\/pay\.paypay\.ne\.jp\//,"").split(/[?#/]/)[0] ?? "";
}

export type PayPaySession={accessToken:string;cookies:Record<string,string>;expiresAt?:number};

export type PayPayAccount={
  phone:string;
  password:string;
  uuid:string;
  session?:PayPaySession|null;
  persistSession?:(session:PayPaySession)=>Promise<void>;
};

function setCookieList(headers:Headers):string[]{
  const withList=headers as Headers&{getSetCookie?:()=>string[]};
  if(typeof withList.getSetCookie==="function") return withList.getSetCookie();
  const joined=headers.get("set-cookie");
  // Fallback: a joined header is split only where a new name=value starts.
  return joined?joined.split(/,\s*(?=[^;,=\s]+=)/):[];
}

function mergeCookies(cookies:Record<string,string>,headers:Headers){
  for(const part of setCookieList(headers)){
    const pair=part.split(";")[0]?.trim()??"";
    const eq=pair.indexOf("=");
    if(eq<=0) continue;
    const value=pair.slice(eq+1);
    // Refuse values that could inject into the Cookie header.
    if(/[\r\n;]/.test(value)) continue;
    cookies[pair.slice(0,eq)]=value;
  }
}

function cookieHeader(cookies:Record<string,string>):string{
  return Object.entries(cookies).map(([name,value])=>`${name}=${value}`).join("; ");
}

// PayPay's receive endpoint expects JST wall-clock time with a fixed +0900 suffix.
// Used only when the link does not report its own transactionAt.
function jstRequestAt():string{
  return new Date(Date.now()+9*3600_000).toISOString().slice(0,19)+"+0900";
}

type OAuthReply={status:number;data:any;session:PayPaySession|null};

async function payPayOAuth(payload:Record<string,unknown>):Promise<OAuthReply>{
  const response=await fetch(PAYPAY_TOKEN_ENDPOINT,{
    method:"POST",
    headers:payPayHeaders(PAYPAY_SIGN_IN_REFERER),
    body:JSON.stringify(payload)
  });
  const data:any=await response.json().catch(()=>null);
  if(!(response.status>=200&&response.status<300)||typeof data?.access_token!=="string"||data.access_token.length<10){
    return {status:response.status,data,session:null};
  }
  const cookies:Record<string,string>={};
  mergeCookies(cookies,response.headers);
  // The HttpOnly `token` cookie authorizes link check/accept. If PayPay did not
  // set one, fall back to the OAuth access token (earlier observed behavior).
  if(!cookies.token) cookies.token=data.access_token;
  const expiresIn=Number(data.expires_in);
  const lifetime=Number.isFinite(expiresIn)&&expiresIn>0
    ?Math.min(expiresIn*1000,PAYPAY_SESSION_MAX_MS)
    :PAYPAY_SESSION_MAX_MS;
  return {
    status:response.status,
    data,
    session:{accessToken:data.access_token,cookies,expiresAt:Date.now()+lifetime}
  };
}

/** Password login. Returns PayPay's reply (OTP challenge or token) plus a session when logged in. */
export async function payPayLoginStart(phone:string,password:string,uuid:string){
  const reply=await payPayOAuth({
    scope:"SIGN_IN",client_uuid:uuid,grant_type:"password",
    username:phone,password,add_otp_prefix:true,language:"ja"
  });
  return {...(reply.data??{}),session:reply.session} as any;
}

/** OTP login with the same client_uuid. The returned session is ready for payments. */
export async function payPayLoginOtp(input:{uuid:string;otp:string;otpReferenceId:string;otpPrefix:string}){
  const reply=await payPayOAuth({
    scope:"SIGN_IN",grant_type:"otp",client_uuid:input.uuid,
    otp:input.otp,otp_prefix:String(input.otpPrefix),
    otp_reference_id:input.otpReferenceId,username_type:"MOBILE",language:"ja"
  });
  return {...(reply.data??{}),session:reply.session} as any;
}

function authFailed(status:number,data:any){
  if(status===401||status===403) return true;
  const code=data?.header?.resultCode;
  // An expired Web session is answered with S0001 (or S9999) at HTTP 200.
  return code==="S0001"||code==="S9999";
}

function holdCode(body:any):string|null{
  if(!body||typeof body!=="object") return null;
  const found:string[]=[];
  const collect=(obj:any)=>{
    if(!obj||typeof obj!=="object") return;
    for(const field of ["resultCode","result_code","errorCode","error_code","code"]){
      const value=obj[field];
      if(typeof value==="string"||typeof value==="number") found.push(String(value));
    }
  };
  collect(body);
  for(const key of ["header","error","result_info","resultInfo"]) collect(body[key]);
  if(Array.isArray(body.errors)) body.errors.slice(0,10).forEach(collect);
  return found.find(code=>PAYPAY_HOLD_CODES.has(code))??null;
}

/**
 * One authenticated Web session for a single operation. Logs in with the saved
 * credentials when there is no valid session; a password login that asks for
 * OTP means the seller must log in again from the dashboard (LOGIN_REQUIRED).
 */
class PayPayWebClient{
  private session:PayPaySession|null;
  private changed=false;
  constructor(private account:PayPayAccount){
    const saved=account.session??null;
    // Sessions saved before expiresAt existed are tried once and renewed on auth failure.
    this.session=saved&&(!saved.expiresAt||saved.expiresAt>Date.now()+60_000)?saved:null;
  }

  private async login():Promise<PayPaySession|null>{
    const reply=await payPayOAuth({
      scope:"SIGN_IN",client_uuid:this.account.uuid,grant_type:"password",
      username:this.account.phone,password:this.account.password,add_otp_prefix:true,language:"ja"
    });
    this.session=reply.session;
    if(reply.session) this.changed=true;
    return reply.session;
  }

  private async ensure():Promise<PayPaySession|null>{
    return this.session??await this.login();
  }

  private async send(method:"GET"|"POST",url:string,referer:string,body?:unknown){
    const session=await this.ensure();
    if(!session) return {status:0,data:null as any,loginRequired:true};
    const response=await fetch(url,{
      method,
      headers:payPayHeaders(referer,{"Cookie":cookieHeader(session.cookies)}),
      ...(body===undefined?{}:{body:JSON.stringify(body)})
    });
    const before=JSON.stringify(session.cookies);
    mergeCookies(session.cookies,response.headers);
    if(JSON.stringify(session.cookies)!==before) this.changed=true;
    const data:any=await response.json().catch(()=>null);
    return {status:response.status,data,loginRequired:false};
  }

  /** An auth rejection means the request was not processed, so one retry after re-login is safe. */
  async request(method:"GET"|"POST",url:string,referer:string,body?:unknown){
    let result=await this.send(method,url,referer,body);
    if(!result.loginRequired&&authFailed(result.status,result.data)){
      this.session=null;
      result=await this.send(method,url,referer,body);
    }
    return result;
  }

  async linkInfo(code:string){
    const url=PAYPAY_LINK_INFO_ENDPOINT+
      "?verificationCode="+encodeURIComponent(code)+
      "&client_uuid="+encodeURIComponent(this.account.uuid);
    return this.request("GET",url,payPayLinkReferer(code));
  }

  async persist(){
    if(!this.changed||!this.session||!this.account.persistSession) return;
    try{ await this.account.persistSession(this.session); }
    catch(error){ console.error("PayPay session save failed",error); }
  }
}

/**
 * Authenticated link lookup (Web API). Returns the link JSON when PayPay answers
 * S0000, otherwise null. Requires the seller's PayPay account.
 */
export async function checkPayPayLink(link:string,account:PayPayAccount){
  const code=payCode(link);
  if(!code) return null;
  const client=new PayPayWebClient(account);
  try{
    const result=await client.linkInfo(code);
    if(result.loginRequired||result.status!==200) return null;
    if(result.data?.header?.resultCode!=="S0000") return null;
    return result.data;
  }finally{
    await client.persist();
  }
}

export type PayPayWalletSplit={
  money:number;
  moneyLight:number;
  known:boolean;
};

export function payPayWalletSplit(info:any):PayPayWalletSplit{
  const split=info?.payload?.message?.data?.subWalletSplit;
  const money=Number(split?.senderEmoneyAmount);
  const moneyLight=Number(split?.senderPrepaidAmount);
  const known=
    Number.isSafeInteger(money)&&money>=0&&
    Number.isSafeInteger(moneyLight)&&moneyLight>=0;
  return {
    money:known?money:0,
    moneyLight:known?moneyLight:0,
    known
  };
}

function acceptConfirmed(status:number,body:any){
  return status===200&&
    body?.header?.resultCode==="S0000"&&
    body?.payload?.orderStatus==="COMPLETED"&&
    (body?.error===undefined||body?.error===null);
}

export async function acceptPayPayLink(
  link:string,
  account:PayPayAccount,
  expectedAmount=1,
  options:{requirePayPayMoney?:boolean}={}
):Promise<{ok:boolean;pending:boolean;amount:number;status:string}>{
  const code=payCode(link);
  const client=new PayPayWebClient(account);
  try{
    const lookup=code?await client.linkInfo(code):null;
    if(lookup?.loginRequired) return {ok:false,pending:true,amount:0,status:"LOGIN_REQUIRED"};
    const info=lookup&&lookup.status===200&&lookup.data?.header?.resultCode==="S0000"?lookup.data:null;
    if(!info) return {ok:false,pending:false,amount:0,status:"INVALID"};
    const amount=Number(info?.payload?.message?.data?.amount??0);
    const status=String(info?.payload?.orderStatus??"UNKNOWN");
    if(!Number.isSafeInteger(amount)||amount<expectedAmount){
      return {ok:false,pending:false,amount,status:"AMOUNT_INSUFFICIENT"};
    }
    if(options.requirePayPayMoney){
      const split=payPayWalletSplit(info);
      if(!split.known){
        return {ok:false,pending:false,amount,status:"PAYPAY_BALANCE_TYPE_UNKNOWN"};
      }
      if(split.moneyLight>0||split.money<expectedAmount){
        return {ok:false,pending:false,amount,status:"PAYPAY_MONEY_LIGHT_NOT_ALLOWED"};
      }
    }
    if(info?.payload?.pendingP2PInfo?.isSetPasscode){
      return {ok:false,pending:false,amount,status:"PASSCODE_REQUIRED"};
    }
    if(status!=="PENDING") return {ok:false,pending:false,amount,status};

    const message=info.payload.message??{};
    const data=message.data??{};
    const pendingInfo=info.payload.pendingP2PInfo??{};
    const receivePayload={
      requestAt:typeof data.transactionAt==="string"&&data.transactionAt?data.transactionAt:jstRequestAt(),
      orderId:pendingInfo.orderId??data.orderId,
      requestId:crypto.randomUUID(),
      senderChannelUrl:message.chatRoomId,
      senderMessageId:message.messageId,
      verificationCode:code,
      client_uuid:account.uuid,
      iosMinimumVersion:"3.45.0",
      androidMinimumVersion:"3.45.0"
    };

    const received=await client.request("POST",PAYPAY_LINK_ACCEPT_ENDPOINT,payPayLinkReferer(code),receivePayload);
    if(received.loginRequired) return {ok:false,pending:true,amount,status:"LOGIN_REQUIRED"};
    if(acceptConfirmed(received.status,received.data)){
      return {ok:true,pending:false,amount,status:"COMPLETED"};
    }
    if(holdCode(received.data)) return {ok:false,pending:true,amount,status:"TEMPORARY_HOLD"};
    // Link state alone cannot prove WHICH account received the money, so only a
    // confirmed acceptance may authorize delivery. Anything else stays pending and
    // is re-checked while the link is still PENDING.
    return {ok:false,pending:true,amount,status:"PENDING"};
  }finally{
    await client.persist();
  }
}

function kyashHeaders(clientUuid:string,installationUuid:string,accessToken?:string){
  const h:Record<string,string>={
    "Content-Type":"application/json","X-Kyash-Client-Id":clientUuid,
    "Accept":"application/json","X-Kyash-Device-Language":"ja",
    "X-Kyash-Client-Version":KYASH_VERSION,"X-Kyash-Device-Info":"iPhone 8, Version:16.7.5",
    "Accept-Language":"ja-jp","X-Kyash-Date":String(Math.round(Date.now()/1000)),
    "User-Agent":"Kyash/2 CFNetwork/1240.0.4 Darwin/20.6.0",
    "X-Kyash-Installation-Id":installationUuid,"X-Kyash-Os":"iOS"
  };
  if(accessToken) h["X-Auth"]=accessToken;
  return h;
}

export async function kyashLoginStart(email:string,password:string,clientUuid:string,installationUuid:string){
  const response=await fetch("https://api.kyash.me/v2/login",{
    method:"POST",headers:kyashHeaders(clientUuid,installationUuid),
    body:JSON.stringify({email,password})
  });
  return response.json() as Promise<any>;
}

export async function kyashLoginOtp(input:{email:string;otp:string;clientUuid:string;installationUuid:string}){
  const response=await fetch("https://api.kyash.me/v2/login/mobile/verify",{
    method:"POST",headers:kyashHeaders(input.clientUuid,input.installationUuid),
    body:JSON.stringify({verificationCode:input.otp,email:input.email})
  });
  return response.json() as Promise<any>;
}

export async function checkKyashLink(link:string){
  const url=link.includes("https://kyash.me/payments/")?link:"https://kyash.me/payments/"+link.trim();
  const response=await fetch(url,{headers:{"User-Agent":"Mozilla/5.0"}});
  if(!response.ok) return null;
  const html=await response.text();
  const amount=(html.match(/class=["'][^"']*amountText text_send[^"']*["'][^>]*>([^<]+)/i)?.[1]??"")
    .replace(/[¥,\s]/g,"");
  const raw=html.match(/data-href-app=["']kyash:\/\/claim\/([^"']+)/i)?.[1];
  if(!amount||!raw) return null;
  return {amount:Number(amount),uuid:raw};
}

export async function receiveKyashLink(link:string,account:{clientUuid:string;installationUuid:string;accessToken:string},expectedAmount=1){
  const info=await checkKyashLink(link);
  if(!info) return {ok:false,amount:0,status:"INVALID"};
  if(!Number.isSafeInteger(info.amount)||info.amount<expectedAmount) return {ok:false,amount:info.amount,status:"AMOUNT_INSUFFICIENT"};
  const response=await fetch("https://api.kyash.me/v1/links/"+encodeURIComponent(info.uuid)+"/receive",{
    method:"PUT",headers:kyashHeaders(account.clientUuid,account.installationUuid,account.accessToken)
  });
  const data:any=await response.json().catch(()=>null);
  const ok=response.ok&&data?.code===200;
  return {ok,pending:!ok&&(response.status>=500||!data),amount:info.amount,status:ok?"COMPLETED":"FAILED"};
}

export async function saveKyashAccount(
  env:Env,userId:string,input:{email:string;password:string;clientUuid:string;installationUuid:string;accessToken:string}
){
  await env.DB.prepare("INSERT INTO vending_payment_accounts(user_id,kyash_email_enc,kyash_password_enc,kyash_client_uuid,kyash_installation_uuid,kyash_access_token_enc,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET kyash_email_enc=excluded.kyash_email_enc,kyash_password_enc=excluded.kyash_password_enc,kyash_client_uuid=excluded.kyash_client_uuid,kyash_installation_uuid=excluded.kyash_installation_uuid,kyash_access_token_enc=excluded.kyash_access_token_enc,updated_at=excluded.updated_at")
    .bind(userId,await encrypt(env.SESSION_ENCRYPTION_KEY,input.email),await encrypt(env.SESSION_ENCRYPTION_KEY,input.password),input.clientUuid,input.installationUuid,await encrypt(env.SESSION_ENCRYPTION_KEY,input.accessToken),Date.now()).run();
}

export async function getKyashAccount(env:Env,userId:string){
  const r=await env.DB.prepare("SELECT kyash_client_uuid,kyash_installation_uuid,kyash_access_token_enc FROM vending_payment_accounts WHERE user_id=?").bind(userId).first<{kyash_client_uuid:string|null;kyash_installation_uuid:string|null;kyash_access_token_enc:string|null}>();
  if(!r?.kyash_client_uuid||!r.kyash_installation_uuid||!r.kyash_access_token_enc) return null;
  return {
    clientUuid:r.kyash_client_uuid,
    installationUuid:r.kyash_installation_uuid,
    accessToken:await decrypt(env.SESSION_ENCRYPTION_KEY,r.kyash_access_token_enc)
  };
}

export async function saveKyashChallenge(env:Env,userId:string,payload:unknown){
  const id=randomId();
  await env.DB.prepare("INSERT INTO vending_payment_login_challenges(id,user_id,provider,payload_enc,expires_at) VALUES (?,?,'kyash',?,?)")
    .bind(id,userId,await encrypt(env.SESSION_ENCRYPTION_KEY,JSON.stringify(payload)),Date.now()+5*60_000).run();
  return id;
}
export async function takeKyashChallenge(env:Env,id:string,userId:string){
  const r=await env.DB.prepare("SELECT payload_enc,expires_at FROM vending_payment_login_challenges WHERE id=? AND user_id=? AND provider='kyash'").bind(id,userId).first<{payload_enc:string;expires_at:number}>();
  if(!r||r.expires_at<Date.now()) return null;
  await env.DB.prepare("DELETE FROM vending_payment_login_challenges WHERE id=?").bind(id).run();
  return JSON.parse(await decrypt(env.SESSION_ENCRYPTION_KEY,r.payload_enc));
}
