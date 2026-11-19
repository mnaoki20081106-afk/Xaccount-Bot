import type { Env } from "./types";
import { decrypt, encrypt, randomId } from "./utils";

// ---------------------------------------------------------------------------
// PayPay Web (www.paypay.ne.jp). Ported from the owner-supplied browser
// implementation (paypayu.py / paypaython_web_mobile.py, 2026-10-29):
//   POST /app/v1/oauth/token                    password / otp login (+ hourly renewal)
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
// about two hours; use the shorter bound. The session is renewed every hour.
export const PAYPAY_SESSION_MAX_MS=7200_000;
export const PAYPAY_REFRESH_MS=3600_000;
const PAYPAY_TIMEOUT_MS=25_000;
const KYASH_VERSION="11.8.1";

// Provider codes that mean "received but temporarily held" (受け取り保留).
export const PAYPAY_HOLD_CODES=new Set(["42007013","42007014","42007015","42007016"]);
export const PAYPAY_HOLD_NOTICE=
  "PayPay側で一時保留になっている可能性があります。"+
  "PayPayアプリで送金の状態を確認し、解除操作が表示される場合は解除してください。"+
  "解除後は販売者側で受取状況を再確認します。"+
  "確認が終わるまで、同じリンクを再送したり新しい送金をしたりしないでください。";

const UUID_RE=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
export const PAYPAY_OTP_RE=/^[0-9]{4}$/;
const LINK_RE=/https:\/\/pay\.paypay\.ne\.jp\/([A-Za-z0-9]{6,128})(?![A-Za-z0-9])/gi;
const LINK_CODE_RE=/^[A-Za-z0-9]{6,128}$/;

export function isPayPayUuid(value:string){ return UUID_RE.test(value); }

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

/**
 * Accepts a bare link code, a link, or a copied notification containing exactly
 * one PayPay link. Any other URL (hidden Markdown target, phishing link, query,
 * fragment, credentials, port) makes the input invalid.
 */
export function normalizePayPayLink(raw:string):string|null{
  if(typeof raw!=="string"||raw.length<1||raw.length>4000) return null;
  const text=raw.trim();
  if(LINK_CODE_RE.test(text)) return text;
  const codes=[...text.matchAll(LINK_RE)].map(match=>match[1]!);
  if(codes.length===0||new Set(codes).size!==1) return null;
  const code=codes[0]!;
  for(const candidate of text.match(/https?:\/\/[^\s<>\[\]()"']+/gi)??[]){
    let parts:URL;
    try{ parts=new URL(candidate.replace(/[.,;。]+$/,"")); }catch{ return null; }
    if(parts.protocol!=="https:"||parts.hostname!=="pay.paypay.ne.jp") return null;
    if(parts.pathname!=="/"+code&&parts.pathname!=="/"+code+"/") return null;
    if(parts.username||parts.password||parts.port||parts.hash||parts.search) return null;
  }
  return code;
}

export type PayPaySession={
  accessToken:string;
  cookies:Record<string,string>;
  expiresAt?:number;
  refreshedAt?:number;
};

export type PayPayAccount={
  phone:string;
  password:string;
  uuid:string;
  session?:PayPaySession|null;
  persistSession?:(session:PayPaySession)=>Promise<void>;
};

/** reference account_valid: a token exists and expires_at - 60s has not passed. */
export function payPaySessionValid(session:PayPaySession|null|undefined,now=Date.now()){
  return Boolean(session?.accessToken&&now<Number(session.expiresAt??0)-60_000);
}

/**
 * reference payment_session_if_valid: payments need a valid session AND the
 * HttpOnly `token` cookie from a successful login. Never conflated with the token.
 */
export function payPayPaymentReady(session:PayPaySession|null|undefined,now=Date.now()){
  const cookie=session?.cookies?.token;
  return payPaySessionValid(session,now)&&typeof cookie==="string"&&cookie.length>0&&!/[\r\n;]/.test(cookie);
}

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


function providerCode(data:any):string|null{
  if(!data||typeof data!=="object") return null;
  const info=data.result_info&&typeof data.result_info==="object"?data.result_info.result_code:null;
  for(const value of [data.error_code,data.code,data.result_code,info]){
    if(typeof value==="string"&&/^[A-Za-z0-9_.-]{1,60}$/.test(value)) return value;
  }
  return null;
}

export type PayPayOAuthResult=
  |{kind:"token";session:PayPaySession}
  |{kind:"otp";otpReferenceId:string;otpPrefix:string}
  |{kind:"rejected";status:number;code:string|null;responseType:string|null;hint:"bad_credentials"|"otp_validation_failed"|null}
  |{kind:"network"};

async function payPayOAuth(payload:Record<string,unknown>):Promise<PayPayOAuthResult>{
  let response:Response;
  let data:any;
  try{
    response=await fetch(PAYPAY_TOKEN_ENDPOINT,{
      method:"POST",
      headers:payPayHeaders(PAYPAY_SIGN_IN_REFERER),
      body:JSON.stringify(payload),
      signal:AbortSignal.timeout(PAYPAY_TIMEOUT_MS)
    });
    data=await response.json().catch(()=>null);
  }catch{
    return {kind:"network"};
  }
  if(response.status>=200&&response.status<300&&typeof data?.access_token==="string"&&data.access_token.length>=10){
    const cookies:Record<string,string>={};
    mergeCookies(cookies,response.headers);
    // Only the HttpOnly `token` cookie PayPay sets authorizes link check/accept.
    // Without it the login still succeeded, but payments are not ready.
    if(!cookies.token) console.warn("PayPay OAuth token issued, but no browser session cookie was returned; receive not verified");
    const expiresIn=Number(data.expires_in);
    const lifetime=Number.isFinite(expiresIn)&&expiresIn>0
      ?Math.min(expiresIn*1000,PAYPAY_SESSION_MAX_MS)
      :PAYPAY_SESSION_MAX_MS;
    const now=Date.now();
    return {kind:"token",session:{accessToken:data.access_token,cookies,expiresAt:now+lifetime,refreshedAt:now}};
  }
  // An OTP challenge may arrive with HTTP 400.
  if(typeof data?.otp_reference_id==="string"&&data.otp_reference_id&&typeof data?.otp_prefix==="string"&&/^[A-Za-z]{2,8}$/.test(data.otp_prefix)){
    return {kind:"otp",otpReferenceId:data.otp_reference_id,otpPrefix:data.otp_prefix};
  }
  const message=data?.result_info?.result_msg;
  const responseType=typeof data?.response_type==="string"&&/^[A-Za-z0-9_.-]{1,50}$/.test(data.response_type)?data.response_type:null;
  return {
    kind:"rejected",
    status:response.status,
    code:providerCode(data),
    responseType,
    hint:message==="Bad credentials"?"bad_credentials"
      :typeof message==="string"&&message.startsWith("Validate OTP call to notification service")?"otp_validation_failed"
      :null
  };
}

/** Password login with the given client_uuid (token, OTP challenge, rejection or network failure). */
export function payPayLoginStart(phone:string,password:string,uuid:string){
  return payPayOAuth({
    scope:"SIGN_IN",client_uuid:uuid,grant_type:"password",
    username:phone,password,add_otp_prefix:true,language:"ja"
  });
}

/** OTP login with the same client_uuid. A token result is ready for payments. */
export function payPayLoginOtp(input:{uuid:string;otp:string;otpReferenceId:string;otpPrefix:string}){
  return payPayOAuth({
    scope:"SIGN_IN",grant_type:"otp",client_uuid:input.uuid,
    otp:input.otp,otp_prefix:String(input.otpPrefix),
    otp_reference_id:input.otpReferenceId,username_type:"MOBILE",language:"ja"
  });
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
 * Uses ONLY the saved session (reference payment_session_if_valid): payment
 * operations never log in, so a buyer's purchase can never trigger an SMS OTP.
 * The session is kept alive by the hourly renewal; when it is missing, expired
 * or rejected the result is LOGIN_REQUIRED.
 */
class PayPayWebClient{
  private session:PayPaySession|null;
  constructor(private account:PayPayAccount){
    const saved=account.session??null;
    this.session=payPayPaymentReady(saved)?saved:null;
  }

  async request(method:"GET"|"POST",url:string,referer:string,body?:unknown){
    const session=this.session;
    if(!session) return {status:0,data:null as any,loginRequired:true};
    const response=await fetch(url,{
      method,
      headers:payPayHeaders(referer,{"Cookie":"token="+session.cookies.token}),
      signal:AbortSignal.timeout(PAYPAY_TIMEOUT_MS),
      ...(body===undefined?{}:{body:JSON.stringify(body)})
    });
    // Error responses (including HTTP 400) can carry a hold code, so always read JSON.
    const data:any=await response.json().catch(()=>null);
    // An auth rejection means the request was not processed; the seller's session
    // must be renewed (hourly job / 今すぐ延長 / re-login), never retried here.
    if(authFailed(response.status,data)) return {status:response.status,data,loginRequired:true};
    return {status:response.status,data,loginRequired:false};
  }

  linkInfo(code:string){
    const url=PAYPAY_LINK_INFO_ENDPOINT+
      "?verificationCode="+encodeURIComponent(code)+
      "&client_uuid="+encodeURIComponent(this.account.uuid);
    return this.request("GET",url,payPayLinkReferer(code));
  }
}

export type PayPayLinkLookup=
  |{kind:"ok";data:any}
  |{kind:"bad_link"}
  |{kind:"login_required"}
  |{kind:"unavailable"}
  |{kind:"invalid"};

/**
 * Authenticated link lookup (reference _get_link). Distinguishes a missing
 * login and a temporary PayPay failure from an invalid link. Does not receive money.
 */
export async function lookupPayPayLink(link:string,account:PayPayAccount):Promise<PayPayLinkLookup>{
  const code=normalizePayPayLink(link);
  if(!code) return {kind:"bad_link"};
  let result;
  try{ result=await new PayPayWebClient(account).linkInfo(code); }
  catch{ return {kind:"unavailable"}; }
  if(result.loginRequired) return {kind:"login_required"};
  if(result.status===429||result.status>=500||result.data===null) return {kind:"unavailable"};
  if(result.status!==200||result.data?.header?.resultCode!=="S0000") return {kind:"invalid"};
  return {kind:"ok",data:result.data};
}

/** Link JSON when the lookup succeeded, otherwise null. */
export async function checkPayPayLink(link:string,account:PayPayAccount){
  const result=await lookupPayPayLink(link,account);
  return result.kind==="ok"?result.data:null;
}

/** Buyer-facing text for a failed lookup. */
export function payPayLookupMessage(result:PayPayLinkLookup){
  switch(result.kind){
    case "bad_link": return "PayPay送金リンクが正しくありません。";
    case "login_required": return "販売者のPayPayログインを確認できません。販売者の再ログイン後にもう一度お試しください。";
    case "unavailable": return "PayPayリンク確認で通信エラーが発生しました。少し待ってからもう一度お試しください。";
    case "invalid": return "PayPayリンクを確認できませんでした。";
    default: return "";
  }
}

export function payPayLinkAmount(info:any):number{
  const value=info?.payload?.pendingP2PInfo?.amount??info?.payload?.message?.data?.amount;
  return typeof value==="number"?value:Number.NaN;
}

function parseIso(value:unknown):number|null{
  if(typeof value!=="string"||!/(Z|[+-]\d{2}:?\d{2})$/.test(value)) return null;
  const time=Date.parse(value);
  return Number.isFinite(time)?time:null;
}

export type PayPayLinkCheck=
  |{ok:true;orderId:string;messageId:string;chatId:string;requestAt:string;amount:number}
  |{ok:false;reason:string;message:string};

/**
 * Validation of a pending link before acceptance (reference: validate_link_info).
 * The amount must equal the order total exactly.
 */
export function validatePayPayLinkInfo(body:any,amount:number):PayPayLinkCheck{
  const fail=(reason:string,message:string):PayPayLinkCheck=>({ok:false,reason,message});
  if(!body||typeof body!=="object"||body?.header?.resultCode!=="S0000") return fail("INVALID","PayPayリンクを確認できませんでした。");
  const p=body.payload;
  if(!p||typeof p!=="object"||p.orderStatus!=="PENDING") return fail("NOT_PENDING","このリンクは未受取状態ではありません。別のリンクを使用してください。");
  const info=p.pendingP2PInfo,message=p.message;
  if(!info||typeof info!=="object"||!message||typeof message!=="object") return fail("MISSING_FIELDS","送金リンクの取引情報が不足しています。");
  if(!Number.isInteger(info.amount)||info.amount!==amount||amount<1) return fail("AMOUNT_MISMATCH","PayPayリンクの送金金額と商品の合計額が一致しません。");
  if(info.isLinkBlocked!==false||info.isSetPasscode!==false) return fail("BLOCKED_OR_PASSCODE","ブロック中またはパスコード付きのリンクは利用できません。");
  const expiresAt=parseIso(info.expiredAt);
  if(expiresAt===null||expiresAt<=Date.now()) return fail("EXPIRED","PayPayリンクの有効期限が切れているか、確認できません。");
  const receiver=p.receiver,sender=p.sender;
  if(!receiver||typeof receiver!=="object"||!sender||typeof sender!=="object") return fail("IDENTITY_MISSING","送金元・受取先を確認できませんでした。");
  const receiverId=receiver.externalId,senderId=sender.externalId;
  if(typeof receiverId!=="string"||!receiverId||typeof senderId!=="string"||!senderId) return fail("IDENTITY_MISSING","送金元・受取先の識別情報が不足しています。");
  if(senderId===receiverId) return fail("SELF_PAYMENT","送金元と受取先が同一のリンクは利用できません。");
  const data=message.data;
  if(!data||typeof data!=="object") return fail("MESSAGE_MISSING","リンクのメッセージ情報が不足しています。");
  const orderId=info.orderId;
  if(typeof orderId!=="string"||!orderId||data.orderId!==orderId) return fail("ORDER_MISMATCH","リンクの注文情報が一致しません。");
  if(data.amount!==amount||data.status!=="PENDING") return fail("MESSAGE_MISMATCH","リンクの金額・状態が一致しません。");
  const messageId=message.messageId,chatId=message.chatRoomId,requestAt=data.transactionAt;
  if(![messageId,chatId,requestAt].every(value=>typeof value==="string"&&value)||parseIso(requestAt)===null){
    return fail("MESSAGE_INCOMPLETE","リンクの受取パラメータが不足しています。");
  }
  return {ok:true,orderId,messageId,chatId,requestAt,amount};
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
    body?.payload!==null&&typeof body?.payload==="object"&&
    body.payload.orderStatus==="COMPLETED"&&
    (body?.error===undefined||body?.error===null);
}

export type PayPayAcceptResult={ok:boolean;pending:boolean;amount:number;status:string;message?:string};

/**
 * Accept one link. Returns ok only after a confirmed acceptance. A timeout or
 * network failure after the POST throws (result UNKNOWN): callers keep the order
 * pending and must not blindly resend the same link.
 */
export async function acceptPayPayLink(
  link:string,
  account:PayPayAccount,
  expectedAmount:number,
  // linkInfo: a lookup made moments ago by the caller, reused to avoid a second request.
  options:{requirePayPayMoney?:boolean;linkInfo?:any}={}
):Promise<PayPayAcceptResult>{
  const code=normalizePayPayLink(link);
  if(!code) return {ok:false,pending:false,amount:0,status:"BAD_LINK",message:"PayPay送金リンクが正しくありません。"};
  const client=new PayPayWebClient(account);
  {
    let lookup:{status:number;data:any;loginRequired:boolean};
    if(options.linkInfo?.header?.resultCode==="S0000") lookup={status:200,data:options.linkInfo,loginRequired:!payPayPaymentReady(account.session)};
    else try{ lookup=await client.linkInfo(code); }
    catch{ return {ok:false,pending:true,amount:0,status:"LINK_NETWORK",message:"PayPayリンク確認で通信エラーが発生しました。"}; }
    if(lookup.loginRequired) return {ok:false,pending:true,amount:0,status:"LOGIN_REQUIRED"};
    // A temporary PayPay failure keeps the reserved order pending instead of failing it.
    if(lookup.status===429||lookup.status>=500||lookup.data===null){
      return {ok:false,pending:true,amount:0,status:"LINK_UNAVAILABLE",message:"PayPayリンク確認で通信エラーが発生しました。"};
    }
    if(lookup.status!==200) return {ok:false,pending:false,amount:0,status:"INVALID",message:"PayPayリンクの確認に失敗しました。"};
    const info=lookup.data;
    const amount=payPayLinkAmount(info);
    const orderStatus=String(info?.payload?.orderStatus??"UNKNOWN");
    if(info?.header?.resultCode==="S0000"&&orderStatus!=="PENDING"){
      return {ok:false,pending:false,amount,status:orderStatus,message:"このリンクは未受取状態ではありません。別のリンクを使用してください。"};
    }
    const verified=validatePayPayLinkInfo(info,expectedAmount);
    if(!verified.ok) return {ok:false,pending:false,amount,status:verified.reason,message:verified.message};
    if(options.requirePayPayMoney){
      const split=payPayWalletSplit(info);
      if(!split.known){
        return {ok:false,pending:false,amount,status:"PAYPAY_BALANCE_TYPE_UNKNOWN"};
      }
      if(split.moneyLight>0||split.money<expectedAmount){
        return {ok:false,pending:false,amount,status:"PAYPAY_MONEY_LIGHT_NOT_ALLOWED"};
      }
    }

    const receivePayload={
      requestAt:verified.requestAt,
      orderId:verified.orderId,
      requestId:crypto.randomUUID(),
      senderChannelUrl:verified.chatId,
      senderMessageId:verified.messageId,
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
    if(holdCode(received.data)) return {ok:false,pending:true,amount,status:"TEMPORARY_HOLD",message:PAYPAY_HOLD_NOTICE};
    // Link state alone cannot prove WHICH account received the money, so only a
    // confirmed acceptance may authorize delivery. Anything else stays pending.
    return {ok:false,pending:true,amount,status:"PENDING",message:"PayPay受取結果を確認できませんでした。再購入せず販売者にお問い合わせください。"};
  }
}

export type PayPayRefreshOutcome="renewed"|"otp_required"|"rejected"|"network_error";

/** Renew the Web session with the SAVED phone/password/client_uuid. Never submits an OTP. */
export async function renewPayPaySession(account:PayPayAccount):Promise<{
  outcome:PayPayRefreshOutcome;session?:PayPaySession;code?:string|null;status?:number|null;responseType?:string|null;
}>{
  const result=await payPayLoginStart(account.phone,account.password,account.uuid);
  if(result.kind==="token") return {outcome:"renewed",session:result.session};
  if(result.kind==="otp") return {outcome:"otp_required"};
  if(result.kind==="network") return {outcome:"network_error"};
  return {outcome:"rejected",code:result.code,status:result.status,responseType:result.responseType};
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
