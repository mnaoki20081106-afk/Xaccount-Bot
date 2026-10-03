import { DEFAULT_RESTOCK_MESSAGE, renderRestockMessage, validateRestockMessage } from "./shiire-restock-message";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import ShiireVendingManager from "./ShiireVendingManager";
import "./shiire-operations.css";

type Channel={id:string;name:string;type?:string;botCanPost?:boolean};
type Role={id:string;name:string;position:number;isEveryone:boolean};
type Section="overview"|"budget"|"funding"|"procurement"|"invite"|"inventory"|"vending"|"logs";
type Settled<T>={ok:true;data:T}|{ok:false;error:string};

type Overview={
  generatedAt:number;
  safety:{
    dryRun:boolean;
    emergencyStop:boolean;
    fundingMode:"manual_hstora"|"binance_auto";
    fundingModeLabel:string;
    binanceAutoFundingServerEnabled:boolean;
    autoPurchaseEnabled:boolean;
    autoProcurementEnabled:boolean;
  };
  settings:Record<string,any>;
  funding:Settled<any>;
  market:Settled<any>;
  balances:{
    hstora:Settled<any>;
    binanceLtc:Settled<any>;
    binanceJpy:Settled<any>;
    hotWallet:{health:any;balanceLtc:number|null};
  };
  withdrawalSafety:Settled<any>;
  providerIssues:Array<{provider:string;error:string}>;
  inventory:Record<string,number>;
  inventoryByClass:Record<string,Record<string,number>>;
  today:{
    count:number;
    amount:number;
    average:number;
    approximateJpy:number|null;
    approximateAverageJpy:number|null;
    byClass:Record<string,{count:number;amount:number;average:number}>;
  };
  orderStatuses:Record<string,number>;
  circuitBreakers:Array<any>;
  recentErrors:Array<any>;
  latestActivity:any|null;
  recentOrders:Array<any>;
  integrations:Record<string,any>;
};
type BinanceDetail={
  market:Settled<any>;
  restrictions:Settled<any>;
  balances:{ltc:Settled<any>;jpy:Settled<any>};
  coinInfo:Settled<any>;
  withdrawalSafety:Settled<any>;
};
type HstoraDetail={
  balance:Settled<any>;
  catalog:Settled<any>;
  cachedProducts:Array<any>;
};
type InventoryDetail={
  summary:Record<string,number>;
  byClass:Record<string,Record<string,number>>;
  supplierProducts:Array<any>;
};
type OrderDetail={statusSummary:Record<string,number>;orders:Array<any>};
type LogDetail={
  logs:Array<any>;
  breakers:Array<any>;
  fundingEvents:Array<any>;
  cryptoTransactions:Array<any>;
};
type FundingControls={
  reserve_jpy:number;
  max_purchase_jpy:number;
  daily_purchase_limit_jpy:number;
  weekly_purchase_limit_jpy:number;
  monthly_purchase_limit_jpy:number;
  min_purchase_jpy:number;
  target_ltc_balance:number;
  max_ltc_balance:number;
  wallet_target_ltc:number;
  wallet_max_ltc:number;
  max_paypay_balance_age_ms:number;
  max_fx_age_ms:number;
  max_fx_jump_percent:number;
  max_ltc_price_jump_percent:number;
};
type ProcurementControls={
  max_unit_price_jpy:number;
  max_no_shadowban_unit_price_usd:number;
  reorder_point:number;
  target_stock:number;
  no_shadowban_reorder_point:number;
  no_shadowban_target_stock:number;
  trial_purchase_count:number;
  max_batch_purchase:number;
  min_seller_rating:number;
  min_product_reviews:number;
  min_sales_count:number;
  max_dispute_rate:number;
  minimum_stock:number;
  seller_quality_mode:"strict_api"|"manual_product_approval"|"trial_only";
  approved_hstora_product_ids:number[];
  max_price_jump_percent:number;
  require_bulk_confirmation:boolean;
  bulk_confirmation_threshold:number;
};
type ProcurementBudgetDetail={
  percentages:{INVITE_CAMPAIGN:number;NO_SHADOWBAN:number;TOP_SEARCH:number};
  budget:{
    initialized:boolean;
    available:{INVITE_CAMPAIGN:number;NO_SHADOWBAN:number;TOP_SEARCH:number};
    totalAvailableUsd:number;
    updatedAt:number;
  };
};
type DailyRestockDetail={
  schedule:{timezone:string;time:string;cronSource:string};
  config:{
    enabled:boolean;
    top_search_target_stock:number;
    no_shadowban_target_stock:number;
    notification_channel_id:string;
    notification_message:string;
    notification_mention?:string;
    panel_channel_id:string;
    panel_message_id:string;
  };
  state:any|null;
  stock:{
    TOP_SEARCH:{current:number;target:number;deficit:number};
    NO_SHADOWBAN:{current:number;target:number;deficit:number};
  };
};
type InviteCampaignDetail={
  settings:{
    enabled:boolean;
    guild_id:string;
    invites_per_reward:number;
    target_stock:number;
  };
  stock:{available:number;target:number;deficit:number};
  runtime:{gateway_ready_at:number|null;last_event_at:number|null;last_error:string|null;updated_at:number|null};
  attribution:{total:number;valid:number;ambiguous:number;unresolved:number};
  progress:Array<any>;
  rewards:Array<any>;
  unresolvedRewards:number;
  currentGuildId:string;
  currentGuildSelected:boolean;
};

const budgetCategories=[
  {key:"NO_SHADOWBAN",label:"シャドウバンなし",tone:"shadow"},
  {key:"TOP_SEARCH",label:"検索上位",tone:"top"},
  {key:"INVITE_CAMPAIGN",label:"招待特典用",tone:"invite"}
] as const;

const sections:Array<{id:Section;label:string}>=[
  {id:"overview",label:"運用状況"},
  {id:"budget",label:"仕入れ設定"},
  {id:"vending",label:"販売設定"},
  {id:"logs",label:"履歴と問題"}
];
function purchasePatches(budget:ProcurementBudgetDetail,controls:ProcurementControls,restock:DailyRestockDetail){
  return {
    budget:{inviteCampaignPercent:budget.percentages.INVITE_CAMPAIGN,noShadowbanPercent:budget.percentages.NO_SHADOWBAN,topSearchPercent:budget.percentages.TOP_SEARCH},
    limits:{max_unit_price_jpy:controls.max_unit_price_jpy,max_no_shadowban_unit_price_usd:controls.max_no_shadowban_unit_price_usd},
    restock:{enabled:restock.config.enabled,topSearchTargetStock:restock.config.top_search_target_stock,noShadowbanTargetStock:restock.config.no_shadowban_target_stock,notificationChannelId:(restock.config.notification_channel_id??"").trim(),notificationMessage:(restock.config.notification_message??"").trim(),notificationMention:restock.config.notification_mention??"everyone"}
  };
}

function num(value:unknown,digits=2){
  const n=Number(value);
  if(!Number.isFinite(n)) return "—";
  return n.toLocaleString("ja-JP",{maximumFractionDigits:digits});
}
function yen(value:unknown){
  const n=Number(value);
  return Number.isFinite(n)?Math.round(n).toLocaleString("ja-JP")+"円":"—";
}
function usd(value:unknown){
  const n=Number(value);
  return Number.isFinite(n)?"$"+n.toLocaleString("ja-JP",{maximumFractionDigits:2}):"—";
}
function when(value:unknown){
  const n=Number(value);
  if(!Number.isFinite(n)||n<=0) return "—";
  return new Date(n).toLocaleString("ja-JP");
}
function settledData<T>(value:Settled<T>|undefined):T|null{
  return value?.ok?value.data:null;
}
function classReady(overview:Overview|null,key:string){
  const row=overview?.inventoryByClass?.[key]??{};
  return Number(row.READY_FOR_DELIVERY??0);
}
function classReserved(overview:Overview|null,key:string){
  const row=overview?.inventoryByClass?.[key]??{};
  return Number(row.VENDING_RESERVED??0);
}
function statusTone(ok:boolean,warn=false){
  return ok?"good":warn?"warn":"bad";
}
function parseJson(value:unknown){
  if(typeof value!=="string") return value;
  try{return JSON.parse(value);}catch{return value;}
}

export default function ShiireOperationsCenter({
  guildId,
  channels,
  roles,
  onNotice,
  onError
}:{
  guildId:string;
  channels:Channel[];
  roles:Role[];
  onNotice:(message:string)=>void;
  onError:(reason:unknown)=>void;
}){
  const [section,setSection]=useState<Section>("overview");
  const [advanced,setAdvanced]=useState(false);
  const savedPurchase=useRef<Record<string,string>>({});
  const mainSection=["overview","vending","logs"].includes(section)?section:"budget";
  const [overviewError,setOverviewError]=useState("");
  const activeGuild=useRef(guildId);
  const overviewRequest=useRef(0);
  const detailRequest=useRef(0);
  const staleRequest=useRef(new Error("STALE_SHIIRE_REQUEST"));
  const [overview,setOverview]=useState<Overview|null>(null);
  const [binance,setBinance]=useState<BinanceDetail|null>(null);
  const [hstora,setHstora]=useState<HstoraDetail|null>(null);
  const [inventory,setInventory]=useState<InventoryDetail|null>(null);
  const [orders,setOrders]=useState<OrderDetail|null>(null);
  const [logs,setLogs]=useState<LogDetail|null>(null);
  const [busy,setBusy]=useState(false);
  const [detailBusy,setDetailBusy]=useState(false);
  const [fundingControls,setFundingControls]=useState<FundingControls|null>(null);
  const [procurementControls,setProcurementControls]=useState<ProcurementControls|null>(null);
  const [procurementBudget,setProcurementBudget]=useState<ProcurementBudgetDetail|null>(null);
  const [budgetError,setBudgetError]=useState("");
  const [dailyRestock,setDailyRestock]=useState<DailyRestockDetail|null>(null);
  const [inviteCampaign,setInviteCampaign]=useState<InviteCampaignDetail|null>(null);
  const [payPayObservation,setPayPayObservation]=useState(0);
  const [usdJpyObservation,setUsdJpyObservation]=useState(0);
  const [controlBusy,setControlBusy]=useState(false);

  const funding=settledData(overview?.funding);
  const ltc=settledData(overview?.balances.binanceLtc);
  const jpy=settledData(overview?.balances.binanceJpy);
  const hstoraBalance=settledData(overview?.balances.hstora);
  const topReady=classReady(overview,"TOP_SEARCH");
  const topReserved=classReserved(overview,"TOP_SEARCH");
  const shadowReady=classReady(overview,"NO_SHADOWBAN");
  const shadowReserved=classReserved(overview,"NO_SHADOWBAN");
  const blockers=
    (overview?.circuitBreakers?.length??0)+
    (overview?.recentErrors?.length??0)+
    (overview?.providerIssues?.length??0);

  const overallState=useMemo(()=>{
    if(overviewError) return {label:"接続エラー",tone:"bad",detail:overviewError};
    if(!overview) return {label:overviewError?"接続エラー":"読込中",tone:overviewError?"bad":"warn",detail:overviewError||"Discord-Shiireの状態を取得しています"};
    if(overview.safety.emergencyStop){
      return {label:"緊急停止",tone:"bad",detail:"自動購入・自動仕入れは停止されています"};
    }
    if(overview.circuitBreakers.length){
      return {label:"要確認",tone:"bad",detail:"連続したエラーのため、自動停止しています。履歴と問題を確認してください"};
    }
    if(overview.providerIssues?.length){
      return {
        label:"API要確認",
        tone:"bad",
        detail:"外部Providerの取得に失敗しています。残高が「—」のままでも正常扱いにしません"
      };
    }
    if(overview.safety.dryRun){
      return {label:"テスト運転",tone:"good",detail:"実際のお金を動かさない安全モードです"};
    }
    if(!overview.safety.autoProcurementEnabled){
      return {label:"待機",tone:"warn",detail:"自動仕入れは停止中です"};
    }
    return {label:"自動運転",tone:"good",detail:"設定範囲内で自動仕入れが有効です"};
  },[overview,overviewError]);

  async function loadOverview(showBusy=true){
    if(activeGuild.current!==guildId) return false;
    const requestId=++overviewRequest.current;
    const active=()=>overviewRequest.current===requestId&&activeGuild.current===guildId;
    const load=async<T,>(path:string,init:RequestInit={},timeoutMs?:number):Promise<T>=>{
      const result=await api<T>(path,init,timeoutMs);
      if(!active()) throw staleRequest.current;
      return result;
    };
    setOverviewError("");
    if(showBusy) setBusy(true);
    try{
      const data=await load<Overview>(
        `/api/guilds/${guildId}/shiire/operations/overview`,
        {},
        25_000
      );
      setOverview(data);
      try{
        setDailyRestock(await load<DailyRestockDetail>(
          `/api/guilds/${guildId}/shiire/daily-restock`,
          {},
          20_000
        ));
      }catch(error){
        if(!active()) throw staleRequest.current;
        // Keep the existing operations center usable during a staggered
        // XAccount-Bot / Discord-Shiire deployment. The settings form
        // will still surface the bridge error if the backend is outdated.
        setDailyRestock(null);
      }
      setFundingControls({
        reserve_jpy:Number(data.settings?.reserve_jpy??0),
        max_purchase_jpy:Number(data.settings?.max_purchase_jpy??0),
        daily_purchase_limit_jpy:Number(data.settings?.daily_purchase_limit_jpy??0),
        weekly_purchase_limit_jpy:Number(data.settings?.weekly_purchase_limit_jpy??0),
        monthly_purchase_limit_jpy:Number(data.settings?.monthly_purchase_limit_jpy??0),
        min_purchase_jpy:Number(data.settings?.min_purchase_jpy??0),
        target_ltc_balance:Number(data.settings?.target_ltc_balance??0),
        max_ltc_balance:Number(data.settings?.max_ltc_balance??0),
        wallet_target_ltc:Number(data.settings?.wallet_target_ltc??0),
        wallet_max_ltc:Number(data.settings?.wallet_max_ltc??0),
        max_paypay_balance_age_ms:Number(data.settings?.max_paypay_balance_age_ms??0),
        max_fx_age_ms:Number(data.settings?.max_fx_age_ms??0),
        max_fx_jump_percent:Number(data.settings?.max_fx_jump_percent??0),
        max_ltc_price_jump_percent:Number(data.settings?.max_ltc_price_jump_percent??0)
      });
      setProcurementControls({
        max_unit_price_jpy:Number(data.settings?.max_unit_price_jpy??80),
        max_no_shadowban_unit_price_usd:Number(data.settings?.max_no_shadowban_unit_price_usd??0.6),
        reorder_point:Number(data.settings?.reorder_point??10),
        target_stock:Number(data.settings?.target_stock??50),
        no_shadowban_reorder_point:Number(data.settings?.no_shadowban_reorder_point??10),
        no_shadowban_target_stock:Number(data.settings?.no_shadowban_target_stock??50),
        trial_purchase_count:Number(data.settings?.trial_purchase_count??10),
        max_batch_purchase:Number(data.settings?.max_batch_purchase??20),
        min_seller_rating:Number(data.settings?.min_seller_rating??0),
        min_product_reviews:Number(data.settings?.min_product_reviews??0),
        min_sales_count:Number(data.settings?.min_sales_count??0),
        max_dispute_rate:Number(data.settings?.max_dispute_rate??0),
        minimum_stock:Number(data.settings?.minimum_stock??1),
        seller_quality_mode:(data.settings?.seller_quality_mode??"trial_only") as ProcurementControls["seller_quality_mode"],
        approved_hstora_product_ids:Array.isArray(data.settings?.approved_hstora_product_ids)
          ?data.settings.approved_hstora_product_ids.map(Number).filter(Number.isSafeInteger)
          :[],
        max_price_jump_percent:Number(data.settings?.max_price_jump_percent??25),
        require_bulk_confirmation:Boolean(data.settings?.require_bulk_confirmation??true),
        bulk_confirmation_threshold:Number(data.settings?.bulk_confirmation_threshold??20)
      });
      setPayPayObservation(Number(data.settings?.observed_paypay_balance_jpy??0));
      setUsdJpyObservation(Number(data.settings?.usd_jpy_rate??0));
      return true;
    }catch(reason){
      if(!active()) return false;
      setOverviewError(reason instanceof Error?reason.message:String(reason));
      onError(reason);
      return false;
    }finally{
      if(active()) setBusy(false);
    }
  }

  function applyProcurementControls(data:any){
    setProcurementControls({
      max_unit_price_jpy:Number(data?.max_unit_price_jpy??80),
      max_no_shadowban_unit_price_usd:Number(data?.max_no_shadowban_unit_price_usd??0.6),
      reorder_point:Number(data?.reorder_point??10),
      target_stock:Number(data?.target_stock??50),
      no_shadowban_reorder_point:Number(data?.no_shadowban_reorder_point??10),
      no_shadowban_target_stock:Number(data?.no_shadowban_target_stock??50),
      trial_purchase_count:Number(data?.trial_purchase_count??10),
      max_batch_purchase:Number(data?.max_batch_purchase??20),
      min_seller_rating:Number(data?.min_seller_rating??0),
      min_product_reviews:Number(data?.min_product_reviews??0),
      min_sales_count:Number(data?.min_sales_count??0),
      max_dispute_rate:Number(data?.max_dispute_rate??0),
      minimum_stock:Number(data?.minimum_stock??1),
      seller_quality_mode:(data?.seller_quality_mode??"trial_only") as ProcurementControls["seller_quality_mode"],
      approved_hstora_product_ids:Array.isArray(data?.approved_hstora_product_ids)
        ?data.approved_hstora_product_ids.map(Number).filter(Number.isSafeInteger)
        :[],
      max_price_jump_percent:Number(data?.max_price_jump_percent??25),
      require_bulk_confirmation:Boolean(data?.require_bulk_confirmation??true),
      bulk_confirmation_threshold:Number(data?.bulk_confirmation_threshold??20)
    });
  }

  async function loadDetail(target:Section){
    if(activeGuild.current!==guildId) return false;
    if(target==="overview"||target==="vending") return;
    const requestId=++detailRequest.current;
    const active=()=>detailRequest.current===requestId&&activeGuild.current===guildId;
    const load=async<T,>(path:string,init:RequestInit={},timeoutMs?:number):Promise<T>=>{
      const result=await api<T>(path,init,timeoutMs);
      if(!active()) throw staleRequest.current;
      return result;
    };
    setDetailBusy(true);
    try{
      if(target==="budget"){
        setProcurementBudget(null);
        setBudgetError("");
        savedPurchase.current={};
        const [data,restock,controls]=await Promise.all([
          load<ProcurementBudgetDetail>(`/api/guilds/${guildId}/shiire/procurement-budget`,{},20_000),
          load<DailyRestockDetail>(`/api/guilds/${guildId}/shiire/daily-restock`,{},20_000),
          load<ProcurementControls>(`/api/guilds/${guildId}/shiire/procurement-settings`,{},20_000)
        ]);
        if(!restock?.config||!Number.isFinite(controls?.max_unit_price_jpy)||!Number.isFinite(controls?.max_no_shadowban_unit_price_usd)) throw new Error("仕入れ設定の応答が不完全です。再取得してください。");
        setDailyRestock(restock);
        applyProcurementControls(controls);
        savedPurchase.current=Object.fromEntries(Object.entries(purchasePatches(data,controls,restock)).map(([key,value])=>[key,JSON.stringify(value)]));
        if(!data?.percentages||!data?.budget?.available){
          throw new Error("配分APIの応答形式が正しくありません。Discord-Shiireの稼働バージョンを確認してください。");
        }
        setProcurementBudget(data);
      }else if(target==="funding"){
        if(overview?.safety.fundingMode==="manual_hstora"){
          setBinance(null);
        }else{
          setBinance(await load<BinanceDetail>(
            `/api/guilds/${guildId}/shiire/operations/binance`, {}, 25_000
          ));
        }
      }else if(target==="procurement"){
        const [nextOrders,nextHstora,nextSettings]=await Promise.all([
          load<OrderDetail>(
            `/api/guilds/${guildId}/shiire/operations/orders`,
            {},
            20_000
          ),
          load<HstoraDetail>(
            `/api/guilds/${guildId}/shiire/operations/hstora`,
            {},
            25_000
          ),
          load<any>(
            `/api/guilds/${guildId}/shiire/procurement-settings`,
            {},
            20_000
          )
        ]);
        setOrders(nextOrders);
        setHstora(nextHstora);
        applyProcurementControls(nextSettings);
      }else if(target==="invite"){
        setInviteCampaign(await load<InviteCampaignDetail>(
          `/api/guilds/${guildId}/shiire/invite-campaign`,
          {},
          20_000
        ));
      }else if(target==="inventory"){
        const [nextInventory,nextRestock]=await Promise.all([
          load<InventoryDetail>(
            `/api/guilds/${guildId}/shiire/operations/inventory`,
            {},
            20_000
          ),
          load<DailyRestockDetail>(
            `/api/guilds/${guildId}/shiire/daily-restock`,
            {},
            20_000
          )
        ]);
        setInventory(nextInventory);
        setDailyRestock(nextRestock);
      }else if(target==="logs"){
        setLogs(null);
        setOrders(null);
        const [nextLogs,nextOrders]=await Promise.all([
          load<LogDetail>(`/api/guilds/${guildId}/shiire/operations/logs`,{},20_000),
          load<OrderDetail>(`/api/guilds/${guildId}/shiire/operations/orders`,{},20_000)
        ]);
        setLogs(nextLogs);
        setOrders(nextOrders);
      }
      return true;
    }catch(reason){
      if(!active()) return false;
      if(target==="budget") setBudgetError(reason instanceof Error?reason.message:String(reason));
      onError(reason);
      return false;
    }finally{
      if(active()) setDetailBusy(false);
    }
  }

  useEffect(()=>{
    activeGuild.current=guildId;
    setOverview(null);
    setBinance(null);
    setHstora(null);
    setInventory(null);
    setOrders(null);
    setLogs(null);
    setFundingControls(null);
    setProcurementControls(null);
    setProcurementBudget(null);
    setBudgetError("");
    setDailyRestock(null);
    setInviteCampaign(null);
    setPayPayObservation(0);
    setUsdJpyObservation(0);
    setSection("overview");
    setAdvanced(false);
    savedPurchase.current={};
    setOverviewError("");
    setBusy(false);
    setDetailBusy(false);
    void loadOverview();
    return ()=>{overviewRequest.current++;detailRequest.current++;};
  },[guildId]);

  useEffect(()=>{
    if(section!=="overview"&&section!=="vending") void loadDetail(section);
    else setDetailBusy(false);
    return ()=>{detailRequest.current++;};
  },[section,guildId]);

  async function refresh(){
    const overviewOk=await loadOverview();
    const detailOk=section!=="overview"&&section!=="vending"?await loadDetail(section):true;
    if(overviewOk&&detailOk) onNotice("仕入れbotの運用情報を更新しました");
  }

  async function setFundingMode(mode:"manual_hstora"|"binance_auto"){
    if(
      mode==="binance_auto"&&
      !confirm("Binance自動LTC購入モードへ切り替えますか？ サーバー側ロックが解除済みの場合だけ有効になります。")
    ) return;
    setControlBusy(true);
    try{
      await api(
        `/api/guilds/${guildId}/shiire/funding/mode`,
        {method:"POST",body:JSON.stringify({mode})},
        20_000
      );
      onNotice(
        mode==="manual_hstora"
          ?"HStoraへのLTC手動補充モードへ切り替えました"
          :"Binance自動LTC購入モードへ切り替えました"
      );
      setBinance(null);
      await loadOverview(false);
    }catch(reason){
      onError(reason);
    }finally{
      setControlBusy(false);
    }
  }

  async function saveFundingControls(){
    if(!fundingControls) return;
    setControlBusy(true);
    try{
      await api(
        `/api/guilds/${guildId}/shiire/funding-settings`,
        {
          method:"PATCH",
          body:JSON.stringify(fundingControls)
        },
        20_000
      );
      onNotice("資金上限を保存しました");
      await loadOverview(false);
    }catch(reason){
      onError(reason);
    }finally{
      setControlBusy(false);
    }
  }

  async function savePayPayObservation(){
    setControlBusy(true);
    try{
      await api(
        `/api/guilds/${guildId}/shiire/funding/paypay-observation`,
        {
          method:"POST",
          body:JSON.stringify({balanceJpy:Math.floor(Number(payPayObservation))})
        },
        20_000
      );
      onNotice("Binanceで利用可能なPayPayマネー観測値を更新しました");
      await loadOverview(false);
    }catch(reason){
      onError(reason);
    }finally{
      setControlBusy(false);
    }
  }

  async function saveUsdJpyObservation(){
    setControlBusy(true);
    try{
      await api(
        `/api/guilds/${guildId}/shiire/funding/usd-jpy-observation`,
        {
          method:"POST",
          body:JSON.stringify({rate:Number(usdJpyObservation)})
        },
        20_000
      );
      onNotice("USD/JPY観測値を更新しました");
      await loadOverview(false);
    }catch(reason){
      onError(reason);
    }finally{
      setControlBusy(false);
    }
  }

  async function confirmDirectLtcFunding(){
    if(!confirm(
      "BinanceのLTC総残高が保留開始時より増えていることを確認しました。今回の増加をPayPay直接購入として確定し、仕入れ処理を再開しますか？"
    )) return;
    setControlBusy(true);
    try{
      const result=await api<{confirmedSpendJpy:number;detectedLtcIncrease:number}>(
        `/api/guilds/${guildId}/shiire/operations/funding/confirm-direct-ltc`,
        {method:"POST",body:"{}"},
        20_000
      );
      onNotice(
        "LTC直接購入を確定しました: "+
        yen(result.confirmedSpendJpy)+
        " / +"+
        num(result.detectedLtcIncrease,8)+
        " LTC"
      );
      await loadOverview(false);
    }catch(reason){
      onError(reason);
    }finally{
      setControlBusy(false);
    }
  }

  async function cancelPendingFunding(){
    if(!confirm("現在のPayPay手動操作待ちを取り消しますか？実際に送金・購入済みなら先に残高を確認してください。")) return;
    setControlBusy(true);
    try{
      await api(
        `/api/guilds/${guildId}/shiire/funding/pending/cancel`,
        {method:"POST",body:"{}"},
        20_000
      );
      onNotice("PayPay手動操作待ちを取り消しました");
      await loadOverview(false);
    }catch(reason){
      onError(reason);
    }finally{
      setControlBusy(false);
    }
  }

  async function savePurchaseSettings(){
    if(controlBusy||detailBusy||!procurementBudget||!procurementControls||!dailyRestock||!savedPurchase.current.budget) return;
    const patches=purchasePatches(procurementBudget,procurementControls,dailyRestock);
    const percentages=Object.values(patches.budget);
    if(percentages.some(value=>!Number.isInteger(value)||value<0||value>100)||percentages.reduce((sum,value)=>sum+value,0)!==100){onError(new Error("仕入れ割合は0〜100の整数で、合計100%にしてください"));return;}
    if([patches.restock.topSearchTargetStock,patches.restock.noShadowbanTargetStock].some(value=>!Number.isInteger(value)||value<0||value>10000)){onError(new Error("在庫目標は0〜10000の整数で入力してください"));return;}
    if(!Number.isInteger(patches.limits.max_unit_price_jpy)||patches.limits.max_unit_price_jpy<=0||!Number.isFinite(patches.limits.max_no_shadowban_unit_price_usd)||patches.limits.max_no_shadowban_unit_price_usd<0.50||patches.limits.max_no_shadowban_unit_price_usd>0.60){onError(new Error("単価上限は、USDは0.50〜0.60、円は1以上の整数で入力してください"));return;}
    if(!validateRestockMessage(patches.restock.notificationMessage)){onError(new Error("入荷時のメッセージは、在庫数の差し込み後も2000文字以内になるように入力してください"));return;}
    if(patches.restock.notificationChannelId&&!/^\d{15,22}$/.test(patches.restock.notificationChannelId)){onError(new Error("入荷通知の送信先を選び直してください"));return;}
    const saved:string[]=[];
    const routes=[{key:"budget",label:"予算配分",path:"procurement-budget",method:"POST"},{key:"limits",label:"単価上限",path:"procurement-settings",method:"PATCH"},{key:"restock",label:"在庫と通知",path:"daily-restock/settings",method:"POST"}] as const;
    const requestGuild=guildId;
    const requestId=detailRequest.current;
    const current=()=>activeGuild.current===requestGuild&&detailRequest.current===requestId;
    setControlBusy(true);
    let currentLabel="";
    try{
      for(const route of routes){
        const body=JSON.stringify(patches[route.key]);
        if(savedPurchase.current[route.key]===body) continue;
        currentLabel=route.label;
        const result=await api<any>(`/api/guilds/${requestGuild}/shiire/${route.path}`,{method:route.method,body},25_000);
        if(!current()) return;
        if(route.key==="budget"&&result?.budget) setProcurementBudget(current=>current?{...current,budget:result.budget}:current);
        savedPurchase.current[route.key]=body;
        saved.push(route.label);
      }
      onNotice(saved.length?"仕入れ設定を保存しました":"変更はありません");
    }catch(reason){
      if(current()) onError(new Error(`${currentLabel}を保存できませんでした。${saved.length?saved.join("・")+"は保存済みです。":""}入力を保持しています。再度保存してください。 ${reason instanceof Error?reason.message:String(reason)}`));
    }finally{if(current())setControlBusy(false);}
  }

  async function rebalanceProcurementBudget(){
    if(!confirm("現在のHStora残高を、保存済みの仕入れ割合で再配分しますか？")) return;
    setControlBusy(true);
    try{
      const next=await api<ProcurementBudgetDetail>(
        `/api/guilds/${guildId}/shiire/procurement-budget/rebalance`,
        {method:"POST",body:"{}"},
        25_000
      );
      setProcurementBudget(next);
      onNotice("現在のHStora残高で仕入れ予算を再配分しました");
      await loadOverview(false);
    }catch(reason){
      onError(reason);
    }finally{
      setControlBusy(false);
    }
  }

  async function saveProcurementControls(){
    if(!procurementControls) return;
    if(procurementControls.target_stock<procurementControls.reorder_point){
      onError(new Error("Top Searchの恒常目標は発注点以上にしてください"));
      return;
    }
    if(procurementControls.no_shadowban_target_stock<procurementControls.no_shadowban_reorder_point){
      onError(new Error("No shadow banの恒常目標は発注点以上にしてください"));
      return;
    }
    setControlBusy(true);
    try{
      const result=await api<{settings:ProcurementControls}>(
        `/api/guilds/${guildId}/shiire/procurement-settings`,
        {method:"PATCH",body:JSON.stringify(procurementControls)},
        20_000
      );
      applyProcurementControls(result.settings);
      onNotice("仕入れ条件を保存しました");
      await loadOverview(false);
    }catch(reason){
      onError(reason);
    }finally{
      setControlBusy(false);
    }
  }

  async function runProcurementNow(){
    setControlBusy(true);
    try{
      const result=await api<any>(
        `/api/guilds/${guildId}/shiire/run`,
        {method:"POST",body:"{}"},
        30_000
      );
      onNotice("仕入れ判定を実行しました: "+String(result?.action??"完了"));
      await loadOverview(false);
      if(section==="procurement") await loadDetail("procurement");
    }catch(reason){
      onError(reason);
    }finally{
      setControlBusy(false);
    }
  }

  async function runLtcNow(){
    setControlBusy(true);
    try{
      const result=await api<any>(
        `/api/guilds/${guildId}/shiire/funding/auto-purchase/run`,
        {method:"POST",body:"{}"},
        30_000
      );
      onNotice("LTC購入判定を実行しました: "+String(result?.action??"完了"));
      await loadOverview(false);
      if(section==="funding") await loadDetail("funding");
    }catch(reason){
      onError(reason);
    }finally{
      setControlBusy(false);
    }
  }

  async function installDailyRestockPanelNow(){
    setControlBusy(true);
    try{
      const next=await api<DailyRestockDetail>(
        `/api/guilds/${guildId}/shiire/daily-restock/panel`,
        {method:"POST",body:"{}"},
        20_000
      );
      setDailyRestock(next);
      onNotice("在庫入荷通知パネルを設置 / 更新しました");
    }catch(reason){
      onError(reason);
    }finally{
      setControlBusy(false);
    }
  }

  async function runDailyRestockNow(){
    if(!confirm("18:00を待たず、現在在庫と恒常在庫の差分を今すぐ仕入れますか？")) return;
    setControlBusy(true);
    try{
      const result=await api<any>(
        `/api/guilds/${guildId}/shiire/daily-restock/run`,
        {method:"POST",body:"{}"},
        30_000
      );
      onNotice("差分入荷を実行しました: "+String(result?.action??"完了"));
      await Promise.all([loadOverview(false),loadDetail("budget")]);
    }catch(reason){
      onError(reason);
    }finally{
      setControlBusy(false);
    }
  }

  async function saveInviteCampaign(){
    if(!inviteCampaign) return;
    if(
      !inviteCampaign.currentGuildSelected&&
      inviteCampaign.settings.guild_id&&
      !confirm("招待キャンペーンの対象を現在選択中のサーバーへ切り替えますか？")
    ) return;
    setControlBusy(true);
    try{
      const next=await api<InviteCampaignDetail>(
        `/api/guilds/${guildId}/shiire/invite-campaign/settings`,
        {
          method:"POST",
          body:JSON.stringify({
            enabled:inviteCampaign.settings.enabled,
            invitesPerReward:Number(inviteCampaign.settings.invites_per_reward),
            targetStock:Number(inviteCampaign.settings.target_stock)
          })
        },
        25_000
      );
      setInviteCampaign(next);
      onNotice("招待キャンペーン設定を保存しました");
      await loadOverview(false);
    }catch(reason){
      onError(reason);
    }finally{
      setControlBusy(false);
    }
  }

  async function seedInviteCampaign(){
    setControlBusy(true);
    try{
      const next=await api<InviteCampaignDetail>(
        `/api/guilds/${guildId}/shiire/invite-campaign/seed`,
        {method:"POST",body:"{}"},
        25_000
      );
      setInviteCampaign(next);
      onNotice("Discord招待状態を再同期しました");
    }catch(reason){
      onError(reason);
    }finally{
      setControlBusy(false);
    }
  }

  async function retryInviteReward(id:string){
    setControlBusy(true);
    try{
      const next=await api<InviteCampaignDetail>(
        `/api/guilds/${guildId}/shiire/invite-campaign/rewards/${encodeURIComponent(id)}/retry`,
        {method:"POST",body:"{}"},
        25_000
      );
      setInviteCampaign(next);
      onNotice("招待報酬の配布を再試行しました");
    }catch(reason){
      onError(reason);
    }finally{
      setControlBusy(false);
    }
  }

  async function updateAutomation(
    patch:{
      dry_run?:boolean;
      auto_purchase_enabled?:boolean;
      auto_procurement_enabled?:boolean;
    }
  ){
    if(!overview) return;
    const turningLive=patch.dry_run===false&&overview.safety.dryRun;
    const enablingWhileLive=
      !overview.safety.dryRun&&(
        patch.auto_purchase_enabled===true||
        patch.auto_procurement_enabled===true
      );
    const confirmLive=turningLive||enablingWhileLive;
    if(confirmLive&&!confirm(
      "実際のお金を動かす可能性がある設定です。資金上限・残高・API接続・仕入対象を確認済みですか？"
    )) return;
    setControlBusy(true);
    try{
      await api(
        `/api/guilds/${guildId}/shiire/automation-settings`,
        {
          method:"PATCH",
          body:JSON.stringify({...patch,confirmLive})
        },
        20_000
      );
      onNotice("自動運転設定を更新しました");
      await loadOverview(false);
    }catch(reason){
      onError(reason);
    }finally{
      setControlBusy(false);
    }
  }

  async function setEmergencyStop(enabled:boolean){
    if(!enabled&&!confirm(
      "Emergency Stopを解除しますか？自動購入・自動仕入れはOFFのままです。"
    )) return;
    setControlBusy(true);
    try{
      await api(
        `/api/guilds/${guildId}/shiire/emergency-stop${enabled?"":"/reset"}`,
        {method:"POST",body:"{}"},
        20_000
      );
      onNotice(enabled?"Emergency Stopを有効にしました":"Emergency Stopを解除しました");
      await loadOverview(false);
    }catch(reason){
      onError(reason);
    }finally{
      setControlBusy(false);
    }
  }

  async function approveBulkPurchase(){
    if(!confirm(
      "今後10分間、設定された大量購入閾値以上の仕入れを許可しますか？対象商品・単価・在庫目標を確認してください。"
    )) return;
    setControlBusy(true);
    try{
      await api(
        `/api/guilds/${guildId}/shiire/bulk-approval`,
        {method:"POST",body:JSON.stringify({minutes:10})},
        20_000
      );
      onNotice("大量購入を10分間承認しました");
      await loadOverview(false);
    }catch(reason){
      onError(reason);
    }finally{
      setControlBusy(false);
    }
  }

  async function resetBreaker(key:string){
    if(!confirm(
      `Circuit Breaker「${key}」を解除しますか？原因を確認・解消してから解除してください。`
    )) return;
    setControlBusy(true);
    try{
      await api(
        `/api/guilds/${guildId}/shiire/circuit-breakers/${encodeURIComponent(key)}/reset`,
        {method:"POST",body:"{}"},
        20_000
      );
      onNotice(`Circuit Breaker「${key}」を解除しました`);
      await loadOverview(false);
      if(section==="logs") await loadDetail("logs");
    }catch(reason){
      onError(reason);
    }finally{
      setControlBusy(false);
    }
  }

  const budgetValues=procurementBudget?Object.values(procurementBudget.percentages):[];
  const budgetTotal=budgetValues.reduce((sum,value)=>sum+value,0);
  const budgetValid=budgetValues.length===3&&budgetTotal===100&&budgetValues.every(value=>Number.isInteger(value)&&value>=0&&value<=100);
  const manualFunding=overview?.safety.fundingMode==="manual_hstora";
  const binanceServerUnlocked=Boolean(
    overview?.safety.binanceAutoFundingServerEnabled
  );
  const payPayAllowed=funding?.allowance?.allowedJpy;
  const pendingFunding=funding?.pendingManualFunding;
  const withdrawal=settledData(overview?.withdrawalSafety);
  const hotWallet=overview?.balances.hotWallet;
  const topPolicy={
    max:overview?.settings?.max_unit_price_jpy,
    reorder:overview?.settings?.reorder_point,
    target:overview?.settings?.target_stock
  };
  const shadowPolicy={
    max:overview?.settings?.max_no_shadowban_unit_price_usd,
    reorder:overview?.settings?.no_shadowban_reorder_point,
    target:overview?.settings?.no_shadowban_target_stock
  };

  return (
    <div className="shiire-ops">
      <section className="card shiire-hero">
        <div className="shiire-hero-main">
          <div>
            <div className="shiire-title-row">
              <h2>仕入れbot</h2>
              <span className={`shiire-health ${overallState.tone}`}>
                <i />{overallState.label}
              </span>
            </div>
            <p>{overallState.detail}</p>
          </div>
          <div className="shiire-hero-actions">
            <button
              className={overview?.safety.emergencyStop?"secondary":"danger"}
              onClick={()=>void setEmergencyStop(!overview?.safety.emergencyStop)}
              disabled={busy||detailBusy||controlBusy||!overview}
            >
              {overview?.safety.emergencyStop?"停止解除":"緊急停止"}
            </button>
            <button className="secondary" onClick={()=>void refresh()} disabled={busy||detailBusy||controlBusy}>
              {busy||detailBusy||controlBusy?"更新中…":"更新"}
            </button>
          </div>
        </div>
        <div className="shiire-safety-strip">
          <span className={overview?.safety.dryRun?"safe":"live"}>
            {overview?.safety.dryRun?"テスト運転":"本番運転"}
          </span>
          <span>自動仕入れ {overview?.safety.autoProcurementEnabled?"有効":"停止中"}</span>
          <span>資金 {overview?.safety.fundingModeLabel??"—"}</span>
          {!manualFunding&&(
            <span>LTC自動購入 {overview?.safety.autoPurchaseEnabled?"ON":"OFF"}</span>
          )}
          <span>更新 {when(overview?.generatedAt)}</span>
        </div>
      </section>

      <nav className="shiire-subnav" aria-label="仕入れbot管理メニュー">
        {sections.map(item=>(<button type="button" key={item.id} className={mainSection===item.id?"active":""} aria-current={mainSection===item.id?"page":undefined} disabled={controlBusy} onClick={()=>setSection(item.id)}><strong>{item.label}</strong></button>))}
      </nav>
      {mainSection==="budget"&&<details className="card shiire-disclosure" open={advanced} onToggle={event=>setAdvanced(event.currentTarget.open)}>
        <summary>通常は変更不要の設定</summary>
        <p>招待特典や購入先の品質条件など、必要な場合だけ変更してください。</p>
        <label className="field"><span>変更する設定</span><select value={section} disabled={controlBusy} onChange={event=>setSection(event.target.value as Section)}>
          <option value="budget">普段の仕入れ設定</option><option value="procurement">詳しい購入条件・購入履歴</option><option value="funding">資金の補充方法・運転制限</option><option value="invite">招待特典</option><option value="inventory">在庫の詳しい内訳</option>
        </select></label>
      </details>}

      {overviewError&&<div className="shiire-callout warn" role="alert">
        <strong>運用情報を取得できませんでした</strong><span>{overviewError}</span>
        {overview&&<span>表示中の情報は前回取得時点のものです。</span>}
        <button className="secondary" disabled={busy} onClick={()=>void loadOverview()}>再取得</button>
      </div>}
      {(busy&&!overview)&&<div className="progress"><span /></div>}

      {section==="overview"&&(
        <>
          {overview&&<section className="card shiire-start-guide">
            <h2>普段の操作はこの順番で</h2>
            <ol>
              <li><a href="https://hstora.com/en/wallet" target="_blank" rel="noreferrer">仕入れ先へ入金</a>。ExodusなどのウォレットからLTCを送金すると、反映後に仕入れ予算へ配分されます。</li>
              <li>「仕入れ設定」で予算の割合・在庫目標・単価上限を保存。</li>
              <li>「販売設定」で価格を決め、Discordへ販売画面を設置。</li>
            </ol>
            <div className="shiire-callout neutral" role="status">
              <strong>{overview.safety.emergencyStop?"次に：停止原因を確認し、停止解除":overview.providerIssues?.length?"次に：接続エラーを確認":overview.safety.dryRun?"次に：テスト運転を終了して自動仕入れを開始":!overview.safety.autoProcurementEnabled?"次に：自動仕入れを開始":Number(hstoraBalance?.balance??0)<=0?"次に：HStoraへLTCを補充":"自動仕入れは有効です。通常在庫は18:00に差分補充します。"}</strong>
              {!overview.safety.emergencyStop&&<button className="secondary" disabled={controlBusy||busy} onClick={()=>void updateAutomation(overview.safety.dryRun||!overview.safety.autoProcurementEnabled?{dry_run:false,auto_procurement_enabled:true}:{auto_procurement_enabled:false})}>
                {overview.safety.dryRun||!overview.safety.autoProcurementEnabled?"自動仕入れを開始":"自動仕入れを一時停止"}
              </button>}
            </div>
          </section>}
          <section className="shiire-kpi-grid">
            <article className="card shiire-kpi">
              <span>仕入れに使える残高</span>
              <strong>{usd(hstoraBalance?.balance)}</strong>
              <small>予算の割合は「仕入れ設定」へ</small>
            </article>
            <article className="card shiire-kpi accent">
              <span>シャドウバンなし 在庫</span><strong>{overview?shadowReady:"—"}</strong>
              <small>予約中 {shadowReserved} / 目標 {num(dailyRestock?.config.no_shadowban_target_stock??shadowPolicy.target,0)}</small>
            </article>
            <article className="card shiire-kpi accent">
              <span>検索上位 在庫</span><strong>{overview?topReady:"—"}</strong>
              <small>予約中 {topReserved} / 目標 {num(dailyRestock?.config.top_search_target_stock??topPolicy.target,0)}</small>
            </article>
            <article className="card shiire-kpi accent">
              <span>招待特典用 在庫</span><strong>{overview?classReady(overview,"INVITE_CAMPAIGN"):"—"}</strong>
              <small>招待特典用の在庫</small>
            </article>
          </section>
          {blockers>0&&<div className="shiire-callout warn" role="status">
            <strong>確認が必要な項目が {blockers} 件あります</strong>
            <span>{overview?.providerIssues?.[0]?.error??overview?.circuitBreakers?.[0]?.reason??overview?.recentErrors?.[0]?.message}</span>
            <button className="secondary" onClick={()=>{setAdvanced(true);setSection("logs");}}>障害を確認</button>
          </div>}
          <details className="card shiire-disclosure"><summary>直近の注文</summary>
            <OrderList rows={overview?.recentOrders??[]} compact />
          </details>
          <details className="card shiire-disclosure"><summary>連携状態</summary>
            <div className="shiire-health-list">
              <HealthRow label="HStora API" ok={Boolean(overview?.integrations.hstoraConfigured)} />
              <HealthRow label="暗号化キー" ok={Boolean(overview?.integrations.credentialsEncryptionConfigured)} />
              {!manualFunding&&<HealthRow label="Binance 取引API" ok={Boolean(overview?.integrations.binanceTradeConfigured)} />}
            </div>
          </details>
        </>
      )}

      {section==="budget"&&(
        <section className="card shiire-budget">
          <div className="section-head">
            <div><h2>仕入れ設定</h2><p>予算を分け、在庫が目標に足りない分だけ補充します。変更は一番下のボタンでまとめて保存できます。</p></div>
            <div className="shiire-budget-balance"><span>HStora残高</span><strong>{usd(hstoraBalance?.balance)}</strong></div>
          </div>
          {procurementBudget&&procurementControls&&dailyRestock?<>
            <h3>1. 仕入れ資金の配分</h3><p className="shiire-muted">3種類の合計を100%にします。0%にした種類は購入しません。割合を変更すると現在残高も再配分されます。</p>
            <div className="shiire-budget-rows">
              {budgetCategories.map(({key,label,tone})=>(
                <div className={`shiire-budget-row ${tone}`} key={key}>
                  <div><strong>{label}</strong><span>予算残 {usd(procurementBudget.budget.available[key])}</span></div>
                  <label className="shiire-percent-field">
                    <span className="sr-only">{label}の割合</span>
                    <input type="number" aria-label={label+"の割合"} min="0" max="100" step="1"
                      disabled={controlBusy||detailBusy}
                      value={procurementBudget.percentages[key]}
                      onChange={event=>setProcurementBudget(current=>current?{
                        ...current,percentages:{...current.percentages,[key]:Number(event.target.value)}
                      }:current)} />
                    <span>%</span>
                  </label>
                </div>
              ))}
            </div>
            <div className="shiire-budget-total" role="status">
              <strong>合計 {budgetTotal}%</strong>
              <span>{budgetValid?"保存できます":"0〜100の整数で、合計100%にしてください"}</span>
            </div>
            <fieldset className="shiire-settings-group" disabled={controlBusy||detailBusy}>
              <legend>2. 補充する在庫数</legend><p>毎日18:00（日本時間）に、販売できる在庫が目標に足りない分だけ仕入れます。</p>
              <label className="shiire-checkbox-row"><input type="checkbox" checked={dailyRestock.config.enabled} onChange={event=>setDailyRestock({...dailyRestock,config:{...dailyRestock.config,enabled:event.target.checked}})} /><span>毎日18:00に不足分を補充する</span></label>
              <div className="form-grid two">
                <FundingInput label="シャドウバンなしの在庫目標（個）" value={dailyRestock.config.no_shadowban_target_stock} step={1} onChange={value=>setDailyRestock({...dailyRestock,config:{...dailyRestock.config,no_shadowban_target_stock:value}})} />
                <FundingInput label="検索上位の在庫目標（個）" value={dailyRestock.config.top_search_target_stock} step={1} onChange={value=>setDailyRestock({...dailyRestock,config:{...dailyRestock.config,top_search_target_stock:value}})} />
              </div>
            </fieldset>
            <fieldset className="shiire-settings-group" disabled={controlBusy||detailBusy}>
              <legend>3. 1個あたりの仕入れ上限</legend><p>この金額を超える商品は購入しません。販売価格は「販売設定」で決めます。</p>
              <div className="form-grid two">
                <FundingInput label="シャドウバンなしの単価上限（USD）" value={procurementControls.max_no_shadowban_unit_price_usd} step={0.01} onChange={value=>setProcurementControls({...procurementControls,max_no_shadowban_unit_price_usd:value})} />
                <FundingInput label="検索上位の単価上限（円）" value={procurementControls.max_unit_price_jpy} step={1} onChange={value=>setProcurementControls({...procurementControls,max_unit_price_jpy:value})} />
              </div><small>USDは0.50〜0.60、円は1以上で設定できます。円への換算レートは「通常は変更不要の設定」→「資金の補充方法・運転制限」で確認できます。</small>
            </fieldset>
            <details className="shiire-disclosure"><summary>18時の入荷まとめ通知</summary><p>18時の補充が完了し、在庫が増えた場合だけ1回通知します。選んだメンション先を本文へ自動で差し込みます。</p>
              <label className="field"><span>入荷通知の送信先</span><select disabled={controlBusy} value={dailyRestock.config.notification_channel_id??""} onChange={event=>setDailyRestock({...dailyRestock,config:{...dailyRestock.config,notification_channel_id:event.target.value}})}><option value="">通知しない</option>{channels.filter(channel=>(channel.type==="text"||channel.type==="announcement")&&channel.botCanPost!==false).map(channel=><option key={channel.id} value={channel.id}>#{channel.name}</option>)}</select></label>
              <label className="field"><span>メンション先</span><select disabled={controlBusy} value={dailyRestock.config.notification_mention??"everyone"} onChange={event=>setDailyRestock({...dailyRestock,config:{...dailyRestock.config,notification_mention:event.target.value}})}><option value="everyone">@everyone（全員）</option><option value="">メンションなし</option>{roles.filter(role=>!role.isEveryone).map(role=><option key={role.id} value={role.id}>@{role.name}</option>)}</select></label>
              <label className="field"><span>入荷時のメッセージ</span><textarea maxLength={2000} disabled={controlBusy} value={dailyRestock.config.notification_message??""} onChange={event=>setDailyRestock({...dailyRestock,config:{...dailyRestock.config,notification_message:event.target.value}})} /></label>
              <small>自動差し込み：メンション先 {'{mention}'}、通常商品の現在在庫 {'{normal_stock}'}・追加数 {'{normal_added}'}、Old商品の現在在庫 {'{old_stock}'}・追加数 {'{old_added}'}。数字は自動で更新されます。</small>
              <button className="secondary" disabled={controlBusy} onClick={()=>setDailyRestock({...dailyRestock,config:{...dailyRestock.config,notification_message:DEFAULT_RESTOCK_MESSAGE}})}>指定の通知文に戻す</button>
              <details className="shiire-disclosure"><summary>通知文のプレビュー</summary><p>現在在庫と直近の補充の追加数を使った確認用表示です。通知は送信しません。</p><pre style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>{renderRestockMessage(dailyRestock.config.notification_message??"",{normal_stock:dailyRestock.stock?.NO_SHADOWBAN.current??0,old_stock:dailyRestock.stock?.TOP_SEARCH.current??0,normal_added:dailyRestock.state?.added_no_shadowban??0,old_added:dailyRestock.state?.added_top_search??0},dailyRestock.config.notification_mention??"everyone")}</pre></details>
            </details>
            <div className="shiire-save-bar"><span>予算・在庫目標・単価上限・通知をまとめて保存</span><button className="primary" disabled={controlBusy||detailBusy||!budgetValid} onClick={()=>void savePurchaseSettings()}>{controlBusy?"保存中…":"仕入れ設定を保存"}</button></div>
            <details className="shiire-disclosure"><summary>定時を待たずに入荷・通知画面を設置</summary><p>先に設定を保存してください。「今すぐ不足分を仕入れる」は購入を伴います。</p><div className="shiire-control-buttons"><button className="secondary" disabled={controlBusy||detailBusy} onClick={()=>void runDailyRestockNow()}>今すぐ不足分を仕入れる</button><button className="secondary" disabled={controlBusy||detailBusy} onClick={()=>void installDailyRestockPanelNow()}>入荷通知画面をDiscordへ設置</button></div></details>
            <details className="shiire-disclosure"><summary>配分の詳細・再適用</summary>
              <p className="shiire-muted">予算残 合計 {usd(procurementBudget.budget.totalAvailableUsd)} / 更新 {when(procurementBudget.budget.updatedAt)}</p>
              <button className="secondary" disabled={controlBusy||detailBusy} onClick={()=>void rebalanceProcurementBudget()}>保存済み割合で再配分</button>
            </details>
          </>:detailBusy?<div className="shiire-empty">仕入れ設定を読み込んでいます…</div>:<div className="shiire-callout warn" role="alert">
            <strong>仕入れ設定を取得できませんでした</strong>
            <span>{budgetError||"配分の取得が完了していません。再取得してください。"}</span>
            <span>未入金でも取得に成功すれば予算残は $0 になります。取得失敗を残高0として表示することはありません。</span>
            <button className="secondary" disabled={busy||controlBusy||detailBusy} onClick={()=>void loadDetail("budget")}>仕入れ設定を再取得</button>
          </div>}
        </section>
      )}

      {section==="funding"&&(
        <>
          <section className="card">
            <div className="section-head">
              <div>
                <span className="eyebrow">LTC FUNDING MODE</span>
                <h2>LTC補充方法</h2>
                <p>
                  HStora Main Walletへの入金反映は1分ごとに検知して仕入れ予算へ配分します。
                  No shadow ban / Top Searchの通常在庫は毎日18:00に差分入荷し、招待キャンペーン在庫は随時補充します。
                  Binance自動購入はサーバー側ロック解除後だけ選択できます。
                </p>
              </div>
            </div>
            <div className="shiire-control-buttons">
              <button
                className={manualFunding?"primary":"secondary"}
                disabled={controlBusy}
                onClick={()=>void setFundingMode("manual_hstora")}
              >
                HStoraへLTC手動補充
              </button>
              <button
                className={!manualFunding?"primary":"secondary"}
                disabled={controlBusy||!binanceServerUnlocked}
                onClick={()=>void setFundingMode("binance_auto")}
              >
                Binance自動LTC購入{binanceServerUnlocked?"":"（ロック中）"}
              </button>
            </div>
            <div className={"shiire-callout "+(manualFunding?"neutral":binanceServerUnlocked?"neutral":"warn")}>
              <strong>{overview?.safety.fundingModeLabel??"読込中"}</strong>
              <span>
                {manualFunding
                  ?"HStora WalletでLTCを補充してください。残高増加は1分Cronで検知・予算配分し、通常在庫は18:00に差分入荷します。"
                  :binanceServerUnlocked
                    ?"Binance自動購入のサーバー側ロックは解除済みです。"
                    :"BINANCE_AUTO_FUNDING_ENABLEDがOFFのため実購入はできません。"}
              </span>
            </div>
          </section>

          {manualFunding&&(
            <section className="shiire-kpi-grid">
              <article className="card shiire-kpi">
                <span>HSTORA Main Wallet</span>
                <strong>{usd(hstoraBalance?.balance)}</strong>
                <small>Wallet → Add Funds → LTC で補充</small>
              </article>
              <article className="card shiire-kpi">
                <span>補充後</span>
                <strong>{overview?.safety.autoProcurementEnabled?"18:00自動入荷":"仕入れOFF"}</strong>
                <small>入金反映→予算配分は1分ごと / 通常在庫は18:00</small>
              </article>
            </section>
          )}

          <section className="card">
            <div className="section-head">
              <div>
                <span className="eyebrow">AUTOMATION SAFETY</span>
                <h2>自動運転</h2>
                <p>初期状態はDry Runです。LIVE化・LIVE中の自動ONは確認ダイアログを必須にしています。</p>
              </div>
            </div>
            <div className="shiire-control-buttons">
              <button
                className={overview?.safety.dryRun?"danger":"secondary"}
                disabled={controlBusy||overview?.safety.emergencyStop}
                onClick={()=>void updateAutomation({dry_run:!overview?.safety.dryRun})}
              >
                {overview?.safety.dryRun?"Dry Runを解除":"Dry Runへ戻す"}
              </button>
              {!manualFunding&&(
                <button
                  className={overview?.safety.autoPurchaseEnabled?"secondary":"danger"}
                  disabled={controlBusy||overview?.safety.emergencyStop}
                  onClick={()=>void updateAutomation({
                    auto_purchase_enabled:!overview?.safety.autoPurchaseEnabled
                  })}
                >
                  LTC自動購入 {overview?.safety.autoPurchaseEnabled?"OFFにする":"ONにする"}
                </button>
              )}
              <button
                className={overview?.safety.autoProcurementEnabled?"secondary":"danger"}
                disabled={controlBusy||overview?.safety.emergencyStop}
                onClick={()=>void updateAutomation({
                  auto_procurement_enabled:!overview?.safety.autoProcurementEnabled
                })}
              >
                自動仕入れ {overview?.safety.autoProcurementEnabled?"OFFにする":"ONにする"}
              </button>
            </div>
          </section>

          <details className="shiire-disclosure shiire-funding-details"><summary>補充・為替・自動運転の設定</summary>
          {!manualFunding&&detailBusy&&!binance&&<div className="progress"><span /></div>}
          {!manualFunding&&(
            <section className="shiire-kpi-grid">
              <article className="card shiire-kpi">
                <span>PayPayマネー 観測残高</span>
                <strong>{yen(funding?.observedPayPay?.balanceJpy)}</strong>
                <small>
                  {funding?.observedPayPay?.fresh
                    ?"新規資金に利用可 "+yen(funding?.paypayFunding?.spendableJpy)
                    :"観測値が古い / 未設定"}
                </small>
              </article>
              <article className="card shiire-kpi">
                <span>LTC購入上限</span>
                <strong>{yen(payPayAllowed)}</strong>
                <small>
                  {funding?.allowance?.blockedReason||
                    "既存Binance JPYも含めた購入ポリシー上限"}
                </small>
              </article>
              <article className="card shiire-kpi">
                <span>Binance JPY</span>
                <strong>{yen(jpy?.free)}</strong>
                <small>取引口座 Free</small>
              </article>
              <article className="card shiire-kpi">
                <span>Binance LTC</span>
                <strong>{num(Number(ltc?.free??0)+Number(ltc?.locked??0),8)} LTC</strong>
                <small>目標 {num(overview?.settings.target_ltc_balance,8)} / 最大 {num(overview?.settings.max_ltc_balance,8)}</small>
              </article>
            </section>
          )}

          {!manualFunding&&pendingFunding&&(
            <section className="card shiire-callout warn">
              <strong>PayPay → Binance 手動操作待ち</strong>
              <span>
                最大 {yen(pendingFunding.amountJpy)} をPayPay残高から予約中です。
                JPY即時入金は金額まで確認できれば自動再開します。
                LTC直接購入はLTC総残高の増加を検知後、誤判定防止のため管理者確認が必要です。
              </span>
              {Number(pendingFunding.jpyDepositGrossJpy??0)>0&&(
                <span>
                  JPY即時入金: PayPayから {yen(pendingFunding.jpyDepositGrossJpy)} 支払い →
                  Binance JPYが最低 {yen(pendingFunding.expectedJpyCreditJpy)} 増えれば完了扱い。
                  現行の110円入金手数料を織り込み済みです。
                </span>
              )}
              {Number(pendingFunding.directLtcBudgetJpy??0)>0&&(
                <>
                  <span>
                    LTC直接購入: {yen(pendingFunding.directLtcBudgetJpy)} 分を
                    Binance公式PayPay購入画面で購入する経路も利用できます。
                  </span>
                  {pendingFunding.directLtcIncreaseDetected&&(
                    <div className="shiire-callout neutral">
                      <strong>LTC増加を検知しました</strong>
                      <span>
                        基準 {num(pendingFunding.binanceLtcBaseline,8)} LTC →
                        現在 {num(pendingFunding.currentBinanceLtcTotal,8)} LTC
                        （+{num(pendingFunding.detectedLtcIncrease,8)} LTC）
                      </span>
                      <button
                        className="primary"
                        disabled={controlBusy}
                        onClick={()=>void confirmDirectLtcFunding()}
                      >
                        このLTC購入を確認して再開
                      </button>
                    </div>
                  )}
                </>
              )}
              <button
                className="danger"
                disabled={controlBusy}
                onClick={()=>void cancelPendingFunding()}
              >
                手動操作待ちを取り消す
              </button>
            </section>
          )}

          {!manualFunding&&(
            <section className="card">
              <div className="section-head">
                <div>
                  <span className="eyebrow">FUNDING CONTROLS</span>
                <h2>資金上限を設定</h2>
                <p>既存Binance JPYと新規PayPay支出は別計算です。0の上限は自動購入を止める安全側設定です。</p>
              </div>
              <button
                className="primary"
                disabled={controlBusy||!fundingControls}
                onClick={()=>void saveFundingControls()}
              >
                資金・安全設定を保存
              </button>
              {!manualFunding&&(
                <button
                  className="secondary"
                  disabled={controlBusy}
                  onClick={()=>void runLtcNow()}
                >
                  今すぐLTC購入判定
                </button>
              )}
            </div>
            {fundingControls&&(
              <div className="form-grid two">
                <FundingInput
                  label="PayPayに残す金額（円）"
                  value={fundingControls.reserve_jpy}
                  step={1}
                  onChange={value=>setFundingControls({...fundingControls,reserve_jpy:value})}
                />
                <FundingInput
                  label="1回のLTC購入上限"
                  value={fundingControls.max_purchase_jpy}
                  step={1}
                  onChange={value=>setFundingControls({...fundingControls,max_purchase_jpy:value})}
                />
                <FundingInput
                  label="1日購入上限"
                  value={fundingControls.daily_purchase_limit_jpy}
                  step={1}
                  onChange={value=>setFundingControls({...fundingControls,daily_purchase_limit_jpy:value})}
                />
                <FundingInput
                  label="1週間購入上限"
                  value={fundingControls.weekly_purchase_limit_jpy}
                  step={1}
                  onChange={value=>setFundingControls({...fundingControls,weekly_purchase_limit_jpy:value})}
                />
                <FundingInput
                  label="1か月購入上限"
                  value={fundingControls.monthly_purchase_limit_jpy}
                  step={1}
                  onChange={value=>setFundingControls({...fundingControls,monthly_purchase_limit_jpy:value})}
                />
                <FundingInput
                  label="最低LTC購入額"
                  value={fundingControls.min_purchase_jpy}
                  step={1}
                  onChange={value=>setFundingControls({...fundingControls,min_purchase_jpy:value})}
                />
                <FundingInput
                  label="Binance LTC目標残高"
                  value={fundingControls.target_ltc_balance}
                  step={0.00000001}
                  onChange={value=>setFundingControls({...fundingControls,target_ltc_balance:value})}
                />
                <FundingInput
                  label="Binance LTC最大残高"
                  value={fundingControls.max_ltc_balance}
                  step={0.00000001}
                  onChange={value=>setFundingControls({...fundingControls,max_ltc_balance:value})}
                />
                <FundingInput
                  label="専用Wallet 目標LTC"
                  value={fundingControls.wallet_target_ltc}
                  step={0.00000001}
                  onChange={value=>setFundingControls({...fundingControls,wallet_target_ltc:value})}
                />
                <FundingInput
                  label="専用Wallet 最大LTC"
                  value={fundingControls.wallet_max_ltc}
                  step={0.00000001}
                  onChange={value=>setFundingControls({...fundingControls,wallet_max_ltc:value})}
                />
                <FundingInput
                  label="PayPay観測の有効時間 (ms)"
                  value={fundingControls.max_paypay_balance_age_ms}
                  step={60000}
                  onChange={value=>setFundingControls({...fundingControls,max_paypay_balance_age_ms:value})}
                />
                <FundingInput
                  label="USD/JPY観測の有効時間 (ms)"
                  value={fundingControls.max_fx_age_ms}
                  step={60000}
                  onChange={value=>setFundingControls({...fundingControls,max_fx_age_ms:value})}
                />
                <FundingInput
                  label="USD/JPY急変停止 %"
                  value={fundingControls.max_fx_jump_percent}
                  step={0.1}
                  onChange={value=>setFundingControls({...fundingControls,max_fx_jump_percent:value})}
                />
                <FundingInput
                  label="LTC価格急変停止 %"
                  value={fundingControls.max_ltc_price_jump_percent}
                  step={0.1}
                  onChange={value=>setFundingControls({...fundingControls,max_ltc_price_jump_percent:value})}
                />
              </div>
              )}
            </section>
          )}

          <section className="two-col">
            {!manualFunding&&(
              <article className="card">
                <span className="eyebrow">MANUAL OBSERVATION</span>
              <h2>PayPayマネー残高</h2>
              <p className="shiire-muted">
                BOTはPayPay残高を直接取得しません。ここにはBinance JapanへのJPY即時入金にも使える
                PayPayマネー残高だけを入力してください。PayPayマネーライトや期間限定ポイントは含めません。
                この観測値とreserve_jpyから新規PayPay支出可能額を計算します。
              </p>
              <label className="field">
                <span>Binanceで利用可能なPayPayマネー（円）</span>
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={payPayObservation}
                  onChange={event=>setPayPayObservation(Number(event.target.value))}
                />
              </label>
              <button
                className="primary"
                disabled={controlBusy}
                onClick={()=>void savePayPayObservation()}
              >
                PayPay観測値を保存
              </button>
              </article>
            )}
            <article className="card">
              <span className="eyebrow">FX OBSERVATION</span>
              <h2>仕入れ単価の換算レート</h2>
              <p className="shiire-muted">
                HStoraのUSD価格を円上限と比較するために使います。急変値はCircuit Breakerで拒否します。
              </p>
              <label className="field">
                <span>現在のUSD/JPY</span>
                <input
                  type="number"
                  min="0"
                  step="0.001"
                  value={usdJpyObservation}
                  onChange={event=>setUsdJpyObservation(Number(event.target.value))}
                />
              </label>
              <button
                className="primary"
                disabled={controlBusy}
                onClick={()=>void saveUsdJpyObservation()}
              >
                USD/JPY観測値を保存
              </button>
            </article>
          </section>

          {!manualFunding&&(
            <section className="two-col">
              <article className="card">
                <span className="eyebrow">SPENDING LIMITS</span>
              <h2>資金上限</h2>
              <div className="shiire-detail-grid">
                <Detail label="PayPayに残す金額" value={yen(overview?.settings.reserve_jpy)} />
                <Detail label="1回上限" value={yen(overview?.settings.max_purchase_jpy)} />
                <Detail label="今日 残り" value={yen(funding?.periods?.dayRemainingJpy)} />
                <Detail label="今週 残り" value={yen(funding?.periods?.weekRemainingJpy)} />
                <Detail label="今月 残り" value={yen(funding?.periods?.monthRemainingJpy)} />
                <Detail label="最低購入額" value={yen(overview?.settings.min_purchase_jpy)} />
              </div>
            </article>

            <article className="card">
              <span className="eyebrow">LTC WITHDRAWAL</span>
              <h2>出金安全状態</h2>
              <div className="shiire-health-list">
                <HealthRow label="出金APIキー" ok={Boolean(withdrawal?.configured)} />
                <HealthRow label="固定IP確認" ok={Boolean(withdrawal?.fixedEgressConfirmed)} />
                <HealthRow label="本番の出金が可能" ok={Boolean(withdrawal?.readyForLiveWithdrawal)} />
                <HealthRow
                  label="ホワイトリスト"
                  ok={Number(withdrawal?.allowlistedLtcAddressCount??0)>0}
                  detail={(withdrawal?.allowlistedLtcAddressCount??0)+"件"}
                />
              </div>
              </article>
            </section>
          )}

          <section className="two-col">
            {!manualFunding&&(
              <article className="card">
                <span className="eyebrow">BINANCE DETAIL</span>
              <h2>Binance Japan</h2>
              <div className="shiire-detail-grid">
                <Detail label="利用できるLTC" value={num(settledData(binance?.balances.ltc)?.free,8)+" LTC"} />
                <Detail label="注文などで使用中のLTC" value={num(settledData(binance?.balances.ltc)?.locked,8)+" LTC"} />
                <Detail label="利用できる円残高" value={yen(settledData(binance?.balances.jpy)?.free)} />
                <Detail label="LTC/JPY" value={yen(settledData(binance?.market)?.priceJpy)} />
              </div>
              </article>
            )}
            <article className="card">
              <span className="eyebrow">HOT WALLET</span>
              <h2>専用LTC Wallet</h2>
              <div className="shiire-callout neutral">
                <strong>{manualFunding?"現在の補充先はHStora Main Wallet":"現在は未接続"}</strong>
                <span>
                  {manualFunding
                    ?"秘密鍵をWorkerへ保存せず、HStora WalletへLTCを手動補充します。"
                    :String(hotWallet?.health?.details?.reason??"専用署名ウォレットはまだ接続されていません。")}
                </span>
              </div>
              <div className="shiire-detail-grid">
                <Detail label="目標LTC" value={num(overview?.settings.wallet_target_ltc,8)} />
                <Detail label="最大LTC" value={num(overview?.settings.wallet_max_ltc,8)} />
                <Detail label="実残高" value={hotWallet?.balanceLtc==null?"未取得":num(hotWallet.balanceLtc,8)+" LTC"} />
              </div>
            </article>
          </section>
          </details>
        </>
      )}

      {section==="procurement"&&(
        <>
          {detailBusy&&!orders&&<div className="progress"><span /></div>}
          <section className="card">
            <div className="section-head">
              <div>
                <span className="eyebrow">PROCUREMENT SETTINGS</span>
                <h2>仕入れ条件</h2>
                <p>
                  HStora商品の価格上限・試験購入・品質ガード・大量購入ガードをここから変更できます。
                  18:00の恒常在庫数と在庫通知は「18:00入荷」タブで設定します。
                </p>
              </div>
              <div className="shiire-control-buttons">
                <button
                  className="primary"
                  disabled={controlBusy||!procurementControls}
                  onClick={()=>void saveProcurementControls()}
                >
                  仕入れ条件を保存
                </button>
                <button
                  className="secondary"
                  disabled={controlBusy}
                  onClick={()=>void runProcurementNow()}
                >
                  今すぐ仕入れ判定
                </button>
              </div>
            </div>
            {procurementControls?<>
              <div className="form-grid two">
                <FundingInput
                  label="検索上位 最大単価 (円)"
                  value={procurementControls.max_unit_price_jpy}
                  step={1}
                  onChange={value=>setProcurementControls({...procurementControls,max_unit_price_jpy:value})}
                />
                <FundingInput
                  label="シャドウバンなし 最大単価 (USD)"
                  value={procurementControls.max_no_shadowban_unit_price_usd}
                  step={0.01}
                  onChange={value=>setProcurementControls({...procurementControls,max_no_shadowban_unit_price_usd:value})}
                />
              </div>
              <details className="shiire-disclosure"><summary>詳細な仕入れ条件・品質ガード</summary>
              <div className="form-grid two">
                <FundingInput
                  label="検索上位 発注点"
                  value={procurementControls.reorder_point}
                  step={1}
                  onChange={value=>setProcurementControls({...procurementControls,reorder_point:value})}
                />
                <FundingInput
                  label="検索上位 補充目標（定時入荷以外）"
                  value={procurementControls.target_stock}
                  step={1}
                  onChange={value=>setProcurementControls({...procurementControls,target_stock:value})}
                />
                <FundingInput
                  label="シャドウバンなし 発注点"
                  value={procurementControls.no_shadowban_reorder_point}
                  step={1}
                  onChange={value=>setProcurementControls({...procurementControls,no_shadowban_reorder_point:value})}
                />
                <FundingInput
                  label="シャドウバンなし 補充目標（定時入荷以外）"
                  value={procurementControls.no_shadowban_target_stock}
                  step={1}
                  onChange={value=>setProcurementControls({...procurementControls,no_shadowban_target_stock:value})}
                />
                <FundingInput
                  label="新規商品の初回試験購入数"
                  value={procurementControls.trial_purchase_count}
                  step={1}
                  onChange={value=>setProcurementControls({...procurementControls,trial_purchase_count:value})}
                />
                <FundingInput
                  label="1回最大仕入れ数"
                  value={procurementControls.max_batch_purchase}
                  step={1}
                  onChange={value=>setProcurementControls({...procurementControls,max_batch_purchase:value})}
                />
                <FundingInput
                  label="販売者の最低評価"
                  value={procurementControls.min_seller_rating}
                  step={0.1}
                  onChange={value=>setProcurementControls({...procurementControls,min_seller_rating:value})}
                />
                <FundingInput
                  label="最低レビュー数"
                  value={procurementControls.min_product_reviews}
                  step={1}
                  onChange={value=>setProcurementControls({...procurementControls,min_product_reviews:value})}
                />
                <FundingInput
                  label="最低販売数"
                  value={procurementControls.min_sales_count}
                  step={1}
                  onChange={value=>setProcurementControls({...procurementControls,min_sales_count:value})}
                />
                <FundingInput
                  label="トラブル報告率の上限"
                  value={procurementControls.max_dispute_rate}
                  step={0.01}
                  onChange={value=>setProcurementControls({...procurementControls,max_dispute_rate:value})}
                />
                <FundingInput
                  label="HStora最低在庫"
                  value={procurementControls.minimum_stock}
                  step={1}
                  onChange={value=>setProcurementControls({...procurementControls,minimum_stock:value})}
                />
                <FundingInput
                  label="商品価格急変停止 %"
                  value={procurementControls.max_price_jump_percent}
                  step={0.1}
                  onChange={value=>setProcurementControls({...procurementControls,max_price_jump_percent:value})}
                />
                <FundingInput
                  label="大量購入確認の閾値"
                  value={procurementControls.bulk_confirmation_threshold}
                  step={1}
                  onChange={value=>setProcurementControls({...procurementControls,bulk_confirmation_threshold:value})}
                />
                <label className="field">
                  <span>Seller品質モード</span>
                  <select
                    value={procurementControls.seller_quality_mode}
                    onChange={event=>setProcurementControls({
                      ...procurementControls,
                      seller_quality_mode:event.target.value as ProcurementControls["seller_quality_mode"]
                    })}
                  >
                    <option value="trial_only">trial_only（試験購入）</option>
                    <option value="manual_product_approval">manual_product_approval（承認IDのみ）</option>
                    <option value="strict_api">strict_api（API品質指標必須）</option>
                  </select>
                </label>
                <label className="field">
                  <span>承認済みHStora商品ID（カンマ区切り）</span>
                  <input
                    value={procurementControls.approved_hstora_product_ids.join(",")}
                    onChange={event=>setProcurementControls({
                      ...procurementControls,
                      approved_hstora_product_ids:[...new Set(
                        event.target.value
                          .split(/[\s,]+/)
                          .filter(Boolean)
                          .map(Number)
                          .filter(value=>Number.isSafeInteger(value)&&value>0)
                      )]
                    })}
                  />
                </label>
              </div>
              <label className="shiire-checkbox-row">
                <input
                  type="checkbox"
                  checked={procurementControls.require_bulk_confirmation}
                  onChange={event=>setProcurementControls({
                    ...procurementControls,
                    require_bulk_confirmation:event.target.checked
                  })}
                />
                <span>
                  <strong>大量購入の明示承認を必須にする</strong>
                  <small>閾値以上のLIVE仕入れを自動で止め、承認操作がある時だけ許可します。</small>
                </span>
              </label>
              </details>
            </>:<div className="shiire-empty">仕入れ条件を読み込んでいます。</div>}
          </section>

          <details className="shiire-disclosure"><summary>注文履歴・候補商品・大量購入の承認</summary>
          <section className="shiire-kpi-grid">
            <article className="card shiire-kpi accent">
              <span>TOP_SEARCH 上限</span>
              <strong>{yen(topPolicy.max)}</strong>
              <small>明示的な検索トップ表記必須</small>
            </article>
            <article className="card shiire-kpi accent">
              <span>NO_SHADOWBAN 上限</span>
              <strong>{usd(shadowPolicy.max)}</strong>
              <small>TOP表記なし + No Shadowban</small>
            </article>
            <article className="card shiire-kpi">
              <span>初回試験購入</span>
              <strong>{num(overview?.settings.trial_purchase_count,0)}件</strong>
              <small>新規商品ごと</small>
            </article>
            <article className="card shiire-kpi">
              <span>1回最大仕入れ</span>
              <strong>{num(overview?.settings.max_batch_purchase,0)}件</strong>
              <small>誤大量購入防止</small>
            </article>
          </section>

          <section className="card shiire-callout warn">
            <strong>大量購入の一時承認</strong>
            <span>
              設定閾値以上の仕入れは自動で止まります。内容を確認した時だけ10分間承認してください。
              現在の承認期限: {when(overview?.settings.bulk_approval_until)}
            </span>
            <button
              className="danger"
              disabled={controlBusy}
              onClick={()=>void approveBulkPurchase()}
            >
              10分間だけ大量購入を承認
            </button>
          </section>

          <section className="two-col">
            <article className="card">
              <span className="eyebrow">TODAY BY CLASS</span>
              <h2>今日の仕入れ内訳</h2>
              <ClassStats
                label="TOP_SEARCH"
                data={overview?.today.byClass?.TOP_SEARCH}
                fx={overview?.settings.usd_jpy_rate}
              />
              <ClassStats
                label="NO_SHADOWBAN"
                data={overview?.today.byClass?.NO_SHADOWBAN}
                fx={overview?.settings.usd_jpy_rate}
              />
            </article>
            <article className="card">
              <span className="eyebrow">ORDER STATES</span>
              <h2>仕入れ注文状態</h2>
              <div className="shiire-chip-grid">
                {Object.entries(orders?.statusSummary??overview?.orderStatuses??{}).map(([key,value])=>(
                  <span className="shiire-chip" key={key}>
                    <b>{key}</b>{num(value,0)}
                  </span>
                ))}
              </div>
            </article>
          </section>

          <section className="card">
            <div className="section-head">
              <div>
                <span className="eyebrow">HSTORA CANDIDATES</span>
                <h2>把握済みの仕入れ候補</h2>
              </div>
              <span className="shiire-muted">API残高 {usd(settledData(hstora?.balance)?.balance)}</span>
            </div>
            <div className="shiire-table-wrap">
              <table className="shiire-table">
                <thead><tr><th>分類</th><th>商品</th><th>単価</th><th>在庫</th><th>判定</th><th>更新</th></tr></thead>
                <tbody>
                  {(hstora?.cachedProducts??[]).slice(0,50).map((row:any)=>(
                    <tr key={row.id}>
                      <td><ClassBadge value={row.procurement_class} /></td>
                      <td>{row.title}</td>
                      <td>{String(row.currency).toUpperCase()==="USD"?usd(row.unit_price):yen(row.unit_price)}</td>
                      <td>{num(row.stock_available,0)}</td>
                      <td>{Number(row.qualified)?"Qualified":"対象外"}</td>
                      <td>{when(row.last_seen_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="card">
            <span className="eyebrow">PURCHASE ORDERS</span>
            <h2>仕入れ注文履歴</h2>
            <OrderList rows={orders?.orders??overview?.recentOrders??[]} />
          </section>
          </details>
        </>
      )}

      {section==="invite"&&(
        <>
          {detailBusy&&!inviteCampaign&&<div className="progress"><span /></div>}
          {inviteCampaign?<>
            {!inviteCampaign.currentGuildSelected&&inviteCampaign.settings.guild_id&&(
              <section className="card shiire-callout warn">
                <strong>現在の招待キャンペーンは別サーバーに設定されています</strong>
                <span>
                  この画面で保存すると、招待キャンペーンの対象を現在選択中のサーバーへ切り替えます。
                </span>
              </section>
            )}
            <section className="shiire-kpi-grid">
              <article className="card shiire-kpi accent">
                <span>キャンペーン在庫</span>
                <strong>{num(inviteCampaign.stock.available,0)} / {num(inviteCampaign.stock.target,0)}</strong>
                <small>不足 {num(inviteCampaign.stock.deficit,0)}個</small>
              </article>
              <article className="card shiire-kpi">
                <span>招待条件</span>
                <strong>{num(inviteCampaign.settings.invites_per_reward,0)}人 / 1垢</strong>
                <small>Discord標準招待URL</small>
              </article>
              <article className="card shiire-kpi">
                <span>未解決報酬</span>
                <strong>{num(inviteCampaign.unresolvedRewards,0)}</strong>
                <small>待機 / 再試行対象を含む</small>
              </article>
              <article className="card shiire-kpi">
                <span>Gateway</span>
                <strong>{inviteCampaign.runtime.gateway_ready_at?"接続済み":"未接続"}</strong>
                <small>{when(inviteCampaign.runtime.gateway_ready_at)}</small>
              </article>
            </section>

            <section className="card">
              <div className="section-head">
                <div>
                  <span className="eyebrow">INVITE CAMPAIGN</span>
                  <h2>招待キャンペーン設定</h2>
                  <p>
                    ユーザーはDiscord標準の招待URLを使います。設定人数ごとにキャンペーン専用在庫から1垢をDM配布します。
                  </p>
                </div>
                <div className="shiire-control-buttons">
                  <button className="primary" disabled={controlBusy} onClick={()=>void saveInviteCampaign()}>
                    設定を保存
                  </button>
                  <button className="secondary" disabled={controlBusy} onClick={()=>void seedInviteCampaign()}>
                    招待状態を再同期
                  </button>
                </div>
              </div>

              <label className="shiire-checkbox-row">
                <input
                  type="checkbox"
                  checked={inviteCampaign.settings.enabled}
                  onChange={event=>setInviteCampaign({
                    ...inviteCampaign,
                    settings:{...inviteCampaign.settings,enabled:event.target.checked}
                  })}
                />
                <span>
                  <strong>招待キャンペーンを有効にする</strong>
                  <small>現在選択中のDiscordサーバーを対象にします。</small>
                </span>
              </label>

              <div className="form-grid two">
                <FundingInput
                  label="何人招待ごとに1垢"
                  value={inviteCampaign.settings.invites_per_reward}
                  step={1}
                  onChange={value=>setInviteCampaign({
                    ...inviteCampaign,
                    settings:{...inviteCampaign.settings,invites_per_reward:value}
                  })}
                />
                <FundingInput
                  label="招待キャンペーン恒常在庫"
                  value={inviteCampaign.settings.target_stock}
                  step={1}
                  onChange={value=>setInviteCampaign({
                    ...inviteCampaign,
                    settings:{...inviteCampaign.settings,target_stock:value}
                  })}
                />
              </div>
            </section>

            <section className="two-col">
              <article className="card">
                <span className="eyebrow">INVITE PROGRESS</span>
                <h2>招待実績</h2>
                {(inviteCampaign.progress??[]).length===0
                  ?<div className="shiire-empty">まだ招待実績はありません。</div>
                  :(inviteCampaign.progress??[]).slice(0,40).map((row:any)=>(
                    <div className="shiire-event" key={row.inviter_user_id}>
                      <strong>{row.inviter_user_id}</strong>
                      <span>
                        有効 {num(row.valid_invites,0)}人 / 対象外 {num(row.excluded_invites,0)}人 /
                        報酬 {num(row.rewards_earned,0)}
                      </span>
                    </div>
                  ))
                }
              </article>
              <article className="card">
                <span className="eyebrow">REWARDS</span>
                <h2>報酬履歴</h2>
                {(inviteCampaign.rewards??[]).length===0
                  ?<div className="shiire-empty">まだ報酬履歴はありません。</div>
                  :(inviteCampaign.rewards??[]).slice(0,40).map((row:any)=>{
                    const retryable=["WAITING_STOCK","DM_FAILED","ERROR"].includes(String(row.status));
                    return <div className="shiire-event" key={row.id}>
                      <strong>{row.inviter_user_id} / #{num(row.ordinal,0)}</strong>
                      <span>{String(row.status??"—")}{row.error?" / "+String(row.error):""}</span>
                      {retryable&&(
                        <button
                          className="secondary"
                          disabled={controlBusy}
                          onClick={()=>void retryInviteReward(String(row.id))}
                        >
                          配布を再試行
                        </button>
                      )}
                    </div>;
                  })
                }
              </article>
            </section>
          </>:<div className="shiire-empty">招待キャンペーン情報を読み込んでいます。</div>}
        </>
      )}

      {section==="inventory"&&(
        <>
          {detailBusy&&!inventory&&<div className="progress"><span /></div>}
          <section className="two-col">
            <InventoryClassCard
              title="TOP_SEARCH"
              values={inventory?.byClass?.TOP_SEARCH??overview?.inventoryByClass?.TOP_SEARCH??{}}
              target={Number(dailyRestock?.config.top_search_target_stock??topPolicy.target??0)}
            />
            <InventoryClassCard
              title="NO_SHADOWBAN"
              values={inventory?.byClass?.NO_SHADOWBAN??overview?.inventoryByClass?.NO_SHADOWBAN??{}}
              target={Number(dailyRestock?.config.no_shadowban_target_stock??shadowPolicy.target??0)}
            />
          </section>
          <section className="card">
            <span className="eyebrow">ALL INVENTORY STATES</span>
            <h2>全体ステータス</h2>
            <div className="shiire-chip-grid">
              {Object.entries(inventory?.summary??overview?.inventory??{}).map(([key,value])=>(
                <span className="shiire-chip" key={key}><b>{key}</b>{num(value,0)}</span>
              ))}
            </div>
          </section>
          <section className="card">
            <span className="eyebrow">SOURCE PRODUCTS</span>
            <h2>仕入先商品キャッシュ</h2>
            <div className="shiire-table-wrap">
              <table className="shiire-table">
                <thead><tr><th>分類</th><th>HStora商品</th><th>単価</th><th>HStora在庫</th><th>判定理由</th></tr></thead>
                <tbody>
                  {(inventory?.supplierProducts??[]).slice(0,100).map((row:any)=>{
                    const q=parseJson(row.qualification_json) as any;
                    return <tr key={row.id}>
                      <td><ClassBadge value={row.procurement_class} /></td>
                      <td>{row.title}</td>
                      <td>{String(row.currency).toUpperCase()==="USD"?usd(row.unit_price):yen(row.unit_price)}</td>
                      <td>{num(row.stock_available,0)}</td>
                      <td>{Number(row.qualified)?"Qualified":(q?.reasons??[]).join(", ")||"—"}</td>
                    </tr>;
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {section==="vending"&&(
        <ShiireVendingManager
          key={"ShiireVendingManager:"+guildId}
          guildId={guildId}
          channels={channels}
          roles={roles}
          onNotice={onNotice}
          onError={onError}
        />
      )}

      {section==="logs"&&(
        <>
          {detailBusy&&!logs&&<div className="progress"><span /></div>}
          <section className="card"><h2>仕入れの注文履歴</h2><p>購入結果や処理待ちの注文を確認できます。</p><OrderList rows={orders?.orders??overview?.recentOrders??[]} /></section>
          <section className="two-col">
            <article className="card">
              <span className="eyebrow">CIRCUIT BREAKERS</span>
              <h2>停止中の安全装置</h2>
              {(logs?.breakers??overview?.circuitBreakers??[]).length===0
                ?<div className="shiire-empty">エラーによる自動停止はありません。</div>
                :(logs?.breakers??overview?.circuitBreakers??[]).map((row:any)=>(
                  <div className="shiire-event danger" key={row.key}>
                    <strong>{row.key}</strong>
                    <span>{row.reason||"OPEN"}</span>
                    <small>{when(row.updated_at)}</small>
                    <button
                      className="secondary"
                      disabled={controlBusy}
                      onClick={()=>void resetBreaker(String(row.key))}
                    >
                      原因確認後に解除
                    </button>
                  </div>
                ))}
            </article>
            <article className="card">
              <span className="eyebrow">INTEGRATIONS</span>
              <h2>接続設定</h2>
              <div className="shiire-health-list">
                {Object.entries(overview?.integrations??{}).map(([key,value])=>(
                  <HealthRow
                    key={key}
                    label={({hstoraConfigured:"仕入れ先との接続",credentialsEncryptionConfigured:"納品情報の暗号化",binanceTradeConfigured:"LTC購入用の取引接続",binanceWithdrawConfigured:"LTC出金用の接続",dedicatedHotWallet:"専用送金ウォレット",binanceAutoFundingServerEnabled:"LTCの自動購入を許可",hstoraWebhookConfigured:"仕入れ先からの入荷通知",discordNotifyConfigured:"Discordへの通知"} as Record<string,string>)[key]??key}
                    ok={value===true}
                    neutral={value==="disabled"}
                    detail={value==="disabled"?"無効":value===true?"設定済み":"未設定"}
                  />
                ))}
              </div>
            </article>
          </section>

          <section className="card">
            <span className="eyebrow">AUDIT LOG</span>
            <h2>監査ログ</h2>
            <div className="shiire-log-list">
              {(logs?.logs??[]).map((row:any)=>(
                <div className={`shiire-log-row ${row.level||"info"}`} key={row.id}>
                  <div>
                    <strong>{row.kind}</strong>
                    <span>{row.message}</span>
                  </div>
                  <time>{when(row.created_at)}</time>
                </div>
              ))}
            </div>
          </section>

          <section className="two-col">
            <article className="card">
              <span className="eyebrow">FUNDING EVENTS</span>
              <h2>資金イベント</h2>
              <EventList rows={logs?.fundingEvents??[]} />
            </article>
            <article className="card">
              <span className="eyebrow">WALLET TRANSFERS</span>
              <h2>専用ウォレット送金履歴</h2>
              {overview?.integrations.dedicatedHotWallet==="disabled"
                ?<div className="shiire-empty">
                  専用LTC Walletは現在未接続です。Binance→HStora入金は手動境界のため、
                  この一覧が空でも異常ではありません。BinanceでのLTC購入は左の「資金イベント」に記録されます。
                </div>
                :<EventList rows={logs?.cryptoTransactions??[]} />
              }
            </article>
          </section>
        </>
      )}
    </div>
  );
}

function FundingInput({
  label,value,step,onChange
}:{
  label:string;
  value:number;
  step:number;
  onChange:(value:number)=>void;
}){
  return <label className="field">
    <span>{label}</span>
    <input
      type="number"
      min="0"
      step={step}
      value={value}
      onChange={event=>onChange(Number(event.target.value))}
    />
  </label>;
}

function HealthRow({
  label,ok,detail,neutral=false
}:{label:string;ok:boolean;detail?:string;neutral?:boolean}){
  const tone=neutral?"neutral":statusTone(ok);
  return <div className="shiire-health-row">
    <span className={`shiire-dot ${tone}`} />
    <div><strong>{label}</strong>{detail&&<small>{detail}</small>}</div>
    <b>{neutral?"対象外":ok?"確認済み":"要確認"}</b>
  </div>;
}

function Detail({label,value}:{label:string;value:string}){
  return <div className="shiire-detail"><span>{label}</span><strong>{value}</strong></div>;
}

function ClassStats({
  label,data,fx
}:{label:string;data?:{count:number;amount:number;average:number};fx?:number}){
  const amount=Number(data?.amount??0),average=Number(data?.average??0),rate=Number(fx??0);
  return <div className="shiire-class-stat">
    <ClassBadge value={label} />
    <div><strong>{num(data?.count??0,0)}件</strong><small>仕入れ数</small></div>
    <div><strong>{rate>0?yen(amount*rate):usd(amount)}</strong><small>仕入額</small></div>
    <div><strong>{rate>0?yen(average*rate):usd(average)}</strong><small>平均単価</small></div>
  </div>;
}

function ClassBadge({value}:{value:unknown}){
  const text=String(value??"UNCLASSIFIED");
  const cls=text==="TOP_SEARCH"?"top":text==="NO_SHADOWBAN"?"shadow":"plain";
  return <span className={`shiire-class-badge ${cls}`}>{({TOP_SEARCH:"検索上位",NO_SHADOWBAN:"シャドウバンなし",INVITE_CAMPAIGN:"招待特典用",UNCLASSIFIED:"未分類"} as Record<string,string>)[text]??text}</span>;
}

function InventoryClassCard({
  title,values,target
}:{title:string;values:Record<string,number>;target:number}){
  const ready=Number(values.READY_FOR_DELIVERY??0);
  const reserved=Number(values.VENDING_RESERVED??0);
  const delivered=Number(values.DELIVERED??0);
  return <article className="card">
    <div className="section-head">
      <div><ClassBadge value={title} /><h2>{ready+reserved}件を保有</h2></div>
      <strong>{target}目標</strong>
    </div>
    <div className="shiire-detail-grid">
      <Detail label="販売可能" value={num(ready,0)} />
      <Detail label="注文予約中" value={num(reserved,0)} />
      <Detail label="納品済み累計" value={num(delivered,0)} />
      <Detail label="その他状態" value={num(
        Object.entries(values).filter(([k])=>!["READY_FOR_DELIVERY","VENDING_RESERVED","DELIVERED"].includes(k))
          .reduce((s,[,v])=>s+Number(v),0),0
      )} />
    </div>
  </article>;
}

function OrderList({rows,compact=false}:{rows:Array<any>;compact?:boolean}){
  if(!rows.length) return <div className="shiire-empty">仕入れ注文はまだありません。</div>;
  return <div className={compact?"shiire-order-list compact":"shiire-order-list"}>
    {rows.slice(0,compact?8:60).map(row=>(
      <div className="shiire-order-row" key={row.id}>
        <div>
          <ClassBadge value={row.procurement_class} />
          <strong>HStora #{row.supplier_product_id}</strong>
          <span>{num(row.quantity,0)}件 × {String(row.currency).toUpperCase()==="USD"?usd(row.unit_price):num(row.unit_price)}</span>
        </div>
        <div className="shiire-order-side">
          <b>{({PENDING:"処理待ち",COMPLETED:"完了",FAILED:"失敗",PURCHASED:"購入済み",PROCESSING:"処理中",RECONCILIATION_REQUIRED:"購入結果を確認中",CANCELLED:"キャンセル済み"} as Record<string,string>)[row.status]??row.status}</b>
          <small>{when(row.created_at)}</small>
        </div>
      </div>
    ))}
  </div>;
}

function EventList({rows}:{rows:Array<any>}){
  if(!rows.length) return <div className="shiire-empty">記録はありません。</div>;
  return <div className="shiire-order-list compact">
    {rows.slice(0,30).map((row,index)=>(
      <div className="shiire-order-row" key={row.id??index}>
        <div>
          <strong>{row.kind??row.asset??row.provider??"Event"}</strong>
          <span>{row.provider??""} {row.status??""}</span>
        </div>
        <div className="shiire-order-side">
          <b>{row.amount_jpy?yen(row.amount_jpy):row.amount?num(row.amount,8):""}</b>
          <small>{when(row.created_at)}</small>
        </div>
      </div>
    ))}
  </div>;
}
