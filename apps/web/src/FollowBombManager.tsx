import { useEffect, useMemo, useState } from "react";
import { ApiError, api } from "./api";

type Channel={id:string;name:string;type?:string};
type LinkKind="x_profile"|"x_post"|"url";

type Live=
  |{found:false}
  |{found:true;type:string;rate:number;min:number;max:number;refill:boolean;cancel:boolean;supported:boolean};

type Product={
  id:string;
  name:string;
  description:string;
  emoji:string|null;
  service_id:string;
  service_name:string;
  service_category:string;
  price_percent:number;
  min_qty:number;
  max_qty:number;
  link_kind:LinkKind;
  active:number;
  sales_count:number;
  live:Live;
  per1000:number|null;
  bounds:{min:number;max:number}|null;
};

type Settings={
  panel_title:string;
  panel_description:string;
  panel_color:number;
  panel_image_url:string|null;
  public_log_channel_id:string|null;
  private_log_channel_id:string|null;
  paused:number;
  min_margin_percent:number;
  max_open_orders_per_user:number;
  min_supplier_balance_jpy:number;
};

type Balance=
  |{ok:true;balance:number;currency:string;currencyOk:boolean}
  |{ok:false;error:string};

type Overview={
  configured:boolean;
  balance:Balance;
  payment:{paypay:boolean;kyash:boolean};
  settings:Settings;
  products:Product[];
  panels:Array<{channel_id:string;message_id:string}>;
  summary:{
    byStatus:Record<string,{count:number;amount:number}>;
    refundRequired:{count:number;amount:number};
  };
  servicesCachedAt:number|null;
  limits:{panelProductLimit:number};
};

type Service={
  service:string;
  name:string;
  type:string;
  category:string;
  rate:number;
  min:number;
  max:number;
  refill:boolean;
  cancel:boolean;
  supported:boolean;
};

type Order={
  id:string;
  user_id:string;
  product_name:string;
  link:string;
  quantity:number;
  total_amount:number;
  status:string;
  supplier_order_id:string|null;
  supplier_status:string|null;
  remains:number|null;
  last_error:string|null;
  refund_state:"none"|"required"|"done";
  refund_amount:number;
  created_at:number;
  finished_at:number|null;
};

type Tab="overview"|"products"|"services"|"orders";

const STATUS_LABEL:Record<string,string>={
  awaiting_payment:"支払い待ち",
  payment_pending:"決済確認中",
  paid:"発注待ち",
  placing:"発注中",
  placed:"実行中",
  completed:"完了",
  partial:"一部完了",
  canceled:"キャンセル",
  failed:"失敗",
  hold:"要確認",
  expired:"期限切れ"
};

const LINK_KIND_LABEL:Record<LinkKind,string>={
  x_profile:"Xアカウント(フォロワー等)",
  x_post:"Xポスト(いいね・インプレ等)",
  url:"任意のURL"
};

const ERROR_JA:Record<string,string>={
  SERVICE_NOT_FOUND:"LuckyPanelにそのサービスIDが見つかりません。サービス一覧を再取得してください。",
  PRICE_PERCENT_INVALID:"販売価格は原価の101%以上(101〜1000)で指定してください。",
  MARGIN_BELOW_FLOOR:"この価格設定では最低利益率を下回ります。上乗せ率か手数料を上げてください。",
  TOO_MANY_ACTIVE_PRODUCTS:"同時に販売できる商品は25件までです。不要な商品を非公開にしてください。",
  LUCKYPANEL_SERVICES_UNAVAILABLE:"LuckyPanelのサービス一覧を取得できませんでした。APIキーと接続を確認してください。",
  LUCKYPANEL_API_KEY_NOT_CONFIGURED:"LUCKYPANEL_API_KEYが未設定です。Bot Factoryで仕入れbotに設定してください。",
  CONFIRM_NOT_PLACED_REQUIRED:"LuckyPanel側で未発注であることを確認してから実行してください。",
  ORDER_NOT_RETRYABLE:"この注文は再発注できません。",
  SUPPLIER_REFUSED_CANCEL:"LuckyPanelがキャンセルを受け付けませんでした。",
  CHANNEL_NOT_IN_GUILD:"選択したチャンネルがこのサーバーにありません。"
};

function explain(reason:unknown):unknown{
  if(reason instanceof ApiError){
    const code=reason.code??reason.message.split(":")[0]??"";
    const text=ERROR_JA[code];
    if(text) return new Error(text);
    if(reason.message.startsWith("SERVICE_TYPE_UNSUPPORTED")){
      return new Error("このサービスタイプ("+reason.message.split(":")[1]+")は未対応です。数量指定(Default)のサービスのみ販売できます。");
    }
  }
  return reason;
}

function yen(value:number|null|undefined){
  if(value===null||value===undefined||!Number.isFinite(value)) return "—";
  return "¥"+Math.round(value).toLocaleString("ja-JP");
}

function when(ms:number|null){
  if(!ms) return "—";
  return new Date(ms).toLocaleString("ja-JP",{month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"});
}

function guessLinkKind(service:Service):LinkKind{
  const text=(service.name+" "+service.category).toLowerCase();
  if(/follow|フォロワー|subscriber/.test(text)) return "x_profile";
  if(/like|いいね|retweet|repost|リポスト|impression|インプレ|view|再生|bookmark|ブックマーク|click/.test(text)) return "x_post";
  return "url";
}

function postable(channels:Channel[]){
  return channels.filter(channel=>channel.type==="text"||channel.type==="announcement"||!channel.type);
}

type ProductDraft={
  name:string;description:string;emoji:string;
  price_percent:number;min_qty:number;max_qty:number;
  link_kind:LinkKind;active:boolean;
};

function draftFrom(product:Product):ProductDraft{
  return {
    name:product.name,description:product.description,emoji:product.emoji??"",
    price_percent:product.price_percent,
    min_qty:product.min_qty,max_qty:product.max_qty,
    link_kind:product.link_kind,active:product.active===1
  };
}

export default function FollowBombManager({guildId,channels,onNotice,onError}:{
  guildId:string;
  channels:Channel[];
  onNotice:(message:string)=>void;
  onError:(reason:unknown)=>void;
}){
  const base=`/api/guilds/${guildId}/shiire/smm`;
  const [tab,setTab]=useState<Tab>("overview");
  const [busy,setBusy]=useState(false);
  const [overview,setOverview]=useState<Overview|null>(null);
  const [settings,setSettings]=useState<Settings|null>(null);
  const [panelChannel,setPanelChannel]=useState("");
  const [editingId,setEditingId]=useState("");
  const [draft,setDraft]=useState<ProductDraft|null>(null);
  const [services,setServices]=useState<Service[]|null>(null);
  const [servicesStale,setServicesStale]=useState(false);
  const [query,setQuery]=useState("");
  const [category,setCategory]=useState("");
  const [onlySupported,setOnlySupported]=useState(true);
  const [creating,setCreating]=useState<{service:Service;draft:ProductDraft}|null>(null);
  const [orders,setOrders]=useState<Order[]>([]);
  const [orderFilter,setOrderFilter]=useState("");

  const messageChannels=useMemo(()=>postable(channels),[channels]);

  async function loadOverview(){
    const next=await api<Overview>(base,{},25_000);
    setOverview(next);
    setSettings(next.settings);
    setPanelChannel(current=>current||messageChannels[0]?.id||"");
  }

  async function loadOrders(status=orderFilter){
    const result=await api<{orders:Order[]}>(
      base+"/orders"+(status?`?status=${encodeURIComponent(status)}`:""),{},20_000
    );
    setOrders(result.orders);
  }

  async function run(task:()=>Promise<void>,success?:string){
    setBusy(true);
    try{
      await task();
      if(success) onNotice(success);
    }catch(reason){
      onError(explain(reason));
    }finally{
      setBusy(false);
    }
  }

  useEffect(()=>{void run(loadOverview);},[guildId]);
  useEffect(()=>{if(tab==="orders") void run(()=>loadOrders());},[tab,orderFilter]);

  async function loadServices(refresh:boolean){
    await run(async()=>{
      const result=await api<{services:Service[];stale:boolean}>(
        base+"/services"+(refresh?"?refresh=1":""),{},60_000
      );
      setServices(result.services);
      setServicesStale(result.stale);
    });
  }

  useEffect(()=>{if(tab==="services"&&!services) void loadServices(false);},[tab]);

  async function saveSettings(patch:Partial<Settings>,success="設定を保存しました"){
    await run(async()=>{
      const result=await api<{panelsRefreshed:boolean}>(
        base+"/settings",{method:"POST",body:JSON.stringify(patch)},25_000
      );
      await loadOverview();
      if(!result.panelsRefreshed) onError(new Error("設定は保存しましたが、一部のDiscordパネルを更新できませんでした。"));
    },success);
  }

  async function installPanel(){
    if(!panelChannel) return;
    await run(async()=>{
      await api(base+"/panel",{method:"POST",body:JSON.stringify({channelId:panelChannel})},25_000);
      await loadOverview();
    },"パネルを設置しました");
  }

  async function refreshPanels(){
    await run(async()=>{
      const result=await api<{panelsRefreshed:boolean}>(base+"/panel/refresh",{method:"POST",body:"{}"},25_000);
      if(!result.panelsRefreshed) throw new Error("一部のパネルを更新できませんでした。削除されたパネルは自動で外れます。");
    },"パネルを更新しました");
  }

  async function saveProduct(product:Product){
    if(!draft) return;
    await run(async()=>{
      const result=await api<{panelsRefreshed:boolean}>(
        base+"/products/"+product.id,
        {method:"PATCH",body:JSON.stringify({...draft,emoji:draft.emoji||null})},25_000
      );
      setEditingId("");setDraft(null);
      await loadOverview();
      if(!result.panelsRefreshed) onError(new Error("商品は保存しましたが、一部のDiscordパネルを更新できませんでした。"));
    },"商品を保存しました");
  }

  async function toggleProduct(product:Product){
    await run(async()=>{
      await api(base+"/products/"+product.id,{method:"PATCH",body:JSON.stringify({active:product.active!==1})},25_000);
      await loadOverview();
    },product.active===1?"非公開にしました":"公開しました");
  }

  async function removeProduct(product:Product){
    if(!confirm(`「${product.name}」を削除します。過去の注文履歴は残ります。`)) return;
    await run(async()=>{
      await api(base+"/products/"+product.id,{method:"DELETE"},25_000);
      await loadOverview();
    },"商品を削除しました");
  }

  async function createProduct(){
    if(!creating) return;
    await run(async()=>{
      await api(base+"/products",{
        method:"POST",
        body:JSON.stringify({
          ...creating.draft,emoji:creating.draft.emoji||null,
          service_id:creating.service.service
        })
      },25_000);
      setCreating(null);
      await loadOverview();
      setTab("products");
    },"商品を追加しました");
  }

  async function orderAction(order:Order,body:Record<string,unknown>,success:string){
    await run(async()=>{
      await api(base+"/orders/"+order.id+"/action",{method:"POST",body:JSON.stringify(body)},25_000);
      await loadOrders();
      await loadOverview();
    },success);
  }

  const categories=useMemo(
    ()=>[...new Set((services??[]).map(service=>service.category))].sort(),
    [services]
  );
  const filteredServices=useMemo(()=>{
    const terms=query.toLowerCase().split(/\s+/).filter(Boolean);
    return (services??[]).filter(service=>{
      if(onlySupported&&!service.supported) return false;
      if(category&&service.category!==category) return false;
      const haystack=(service.service+" "+service.name+" "+service.category).toLowerCase();
      return terms.every(term=>haystack.includes(term));
    });
  },[services,query,category,onlySupported]);

  const balance=overview?.balance;
  const refund=overview?.summary.refundRequired;
  const holdCount=overview?.summary.byStatus.hold?.count??0;
  const lowBalance=balance?.ok&&settings&&settings.min_supplier_balance_jpy>0&&balance.balance<settings.min_supplier_balance_jpy;

  return (
    <fieldset className="smm-manager" disabled={busy} aria-label="フォロ爆の管理" style={{border:0,minWidth:0}}>
      <section className="card">
        <div className="section-head">
          <div>
            <h2>フォロ爆(SMM)販売</h2>
            <p>LuckyPanelから無在庫で仕入れ、PayPayで受け取った代金の一部で自動発注します。</p>
          </div>
          <button className="secondary" onClick={()=>void run(async()=>{await loadOverview();if(tab==="orders") await loadOrders();})}>再読み込み</button>
        </div>

        <div className="metric-grid">
          <article className="metric card">
            <span>受付状態</span>
            <strong>{overview?(overview.settings.paused?"停止中":"受付中"):"…"}</strong>
            <small>{overview?.settings.paused?"パネルの注文ボタンは無効です":"購入者が注文できます"}</small>
          </article>
          <article className="metric card">
            <span>LUCKYPANEL残高</span>
            <strong>{!overview?"…":!overview.configured?"未設定":balance?.ok?yen(balance.balance):"取得失敗"}</strong>
            <small>{balance?.ok?(balance.currencyOk?"発注に使われる残高":"通貨がJPYではありません"):(balance?.error??"APIキー未設定")}</small>
          </article>
          <article className="metric card">
            <span>PAYPAY</span>
            <strong>{overview?(overview.payment.paypay?"利用可能":"未設定"):"…"}</strong>
            <small>メインBOTの受取設定を共用</small>
          </article>
          <article className="metric card">
            <span>返金待ち</span>
            <strong>{refund?`${refund.count}件`:"…"}</strong>
            <small>{refund?yen(refund.amount):""}</small>
          </article>
        </div>

        {overview&&!overview.configured&&<div className="shiire-callout warn" role="alert">
          <strong>LuckyPanelのAPIキーが未設定です</strong>
          <span>Bot Factoryで仕入れbotの「LuckyPanel APIキー」を設定して再デプロイしてください。設定するまで注文は受け付けられません。</span>
        </div>}
        {balance?.ok&&!balance.currencyOk&&<div className="shiire-callout warn" role="alert">
          <strong>LuckyPanelの通貨が {balance.currency||"不明"} です</strong>
          <span>価格計算は円建て前提のため、JPY以外では受付しません。</span>
        </div>}
        {lowBalance&&<div className="shiire-callout warn" role="alert">
          <strong>LuckyPanel残高が下限を下回っています</strong>
          <span>LuckyPanelへチャージしてください。残高不足の間は新規注文を受け付けず、入金済みの注文も発注待ちになります。</span>
        </div>}
        {(refund?.count??0)>0&&<div className="shiire-callout warn" role="status">
          <strong>返金対応が必要な注文が {refund!.count} 件あります(合計 {yen(refund!.amount)})</strong>
          <span>購入者へPayPayで返金し、「注文」タブで「返金済みにする」を押してください。</span>
          <button className="secondary" onClick={()=>{setOrderFilter("");setTab("orders");}}>注文を確認</button>
        </div>}
        {holdCount>0&&<div className="shiire-callout warn" role="status">
          <strong>確認が必要な注文が {holdCount} 件あります</strong>
          <span>発注が通ったか不明な注文や、仕入れ価格が上がった注文です。自動では再発注しません。</span>
          <button className="secondary" onClick={()=>{setOrderFilter("hold");setTab("orders");}}>確認する</button>
        </div>}

        <nav className="shiire-subnav" aria-label="フォロ爆管理メニュー">
          {([["overview","概要・設定"],["products","販売商品"],["services","サービスから追加"],["orders","注文"]] as Array<[Tab,string]>).map(([id,label])=>(
            <button key={id} type="button" className={tab===id?"active":""} aria-pressed={tab===id} onClick={()=>setTab(id)}>{label}</button>
          ))}
        </nav>
      </section>

      {tab==="overview"&&settings&&overview&&(
        <>
          <section className="card">
            <h3>受付とパネル</h3>
            <label className="shiire-checkbox-row">
              <input type="checkbox" checked={settings.paused===0} onChange={event=>setSettings({...settings,paused:event.target.checked?0:1})} />
              <span>注文を受け付ける(OFFにするとボタンが無効になります)</span>
            </label>
            <div className="form-grid two">
              <label className="field"><span>パネルタイトル</span>
                <input maxLength={80} value={settings.panel_title} onChange={e=>setSettings({...settings,panel_title:e.target.value})} /></label>
              <label className="field"><span>パネルの色</span>
                <input type="color" aria-label="パネルの色" value={"#"+settings.panel_color.toString(16).padStart(6,"0")}
                  onChange={e=>setSettings({...settings,panel_color:Number.parseInt(e.target.value.slice(1),16)})} /></label>
              <label className="field"><span>公開ログ(完了のみ)</span>
                <select value={settings.public_log_channel_id??""} onChange={e=>setSettings({...settings,public_log_channel_id:e.target.value||null})}>
                  <option value="">送信しない</option>
                  {messageChannels.map(channel=><option key={channel.id} value={channel.id}>#{channel.name}</option>)}
                </select></label>
              <label className="field"><span>非公開ログ(入金・要対応・残高警告)</span>
                <select value={settings.private_log_channel_id??""} onChange={e=>setSettings({...settings,private_log_channel_id:e.target.value||null})}>
                  <option value="">送信しない</option>
                  {messageChannels.map(channel=><option key={channel.id} value={channel.id}>#{channel.name}</option>)}
                </select></label>
            </div>
            <label className="field"><span>パネル説明</span>
              <textarea rows={4} maxLength={1500} value={settings.panel_description} onChange={e=>setSettings({...settings,panel_description:e.target.value})} /></label>
            <label className="field"><span>パネル画像URL(https)</span>
              <input value={settings.panel_image_url??""} onChange={e=>setSettings({...settings,panel_image_url:e.target.value||null})} /></label>

            <h3>安全設定</h3>
            <div className="form-grid two">
              <label className="field"><span>最低利益率(%)</span>
                <input type="number" min={0} max={90} value={settings.min_margin_percent} onChange={e=>setSettings({...settings,min_margin_percent:Number(e.target.value)})} />
                <small>仕入れ原価が支払額のこの割合を超えそうな注文は発注せず「要確認」にします。商品追加時もこの利益率を下回る価格は拒否します。</small></label>
              <label className="field"><span>1人あたりの進行中注文の上限</span>
                <input type="number" min={1} max={50} value={settings.max_open_orders_per_user} onChange={e=>setSettings({...settings,max_open_orders_per_user:Number(e.target.value)})} /></label>
              <label className="field"><span>LuckyPanel残高の下限(円)</span>
                <input type="number" min={0} value={settings.min_supplier_balance_jpy} onChange={e=>setSettings({...settings,min_supplier_balance_jpy:Number(e.target.value)})} />
                <small>注文時にこの金額を残して賄えない数量は受け付けません。下回ると非公開ログへ警告します。0で無効。</small></label>
            </div>
            <div className="button-row">
              <button className="primary" onClick={()=>void saveSettings(settings)}>設定を保存</button>
            </div>
          </section>

          <section className="card">
            <h3>Discordへ設置</h3>
            <div className="form-grid">
              <label className="field"><span>設置するチャンネル</span>
                <select value={panelChannel} onChange={e=>setPanelChannel(e.target.value)}>
                  <option value="">選択してください</option>
                  {messageChannels.map(channel=><option key={channel.id} value={channel.id}>#{channel.name}</option>)}
                </select></label>
              <button className="primary" disabled={!panelChannel} onClick={()=>void installPanel()}>パネルを設置</button>
              <button className="secondary" disabled={!overview.panels.length} onClick={()=>void refreshPanels()}>設置済みパネルを更新({overview.panels.length})</button>
            </div>
            {overview.settings.paused===1&&<p className="shiire-muted">現在は受付停止中です。上の「注文を受け付ける」をONにして保存すると購入できるようになります。</p>}
          </section>
        </>
      )}

      {tab==="products"&&overview&&(
        <section className="card">
          <div className="section-head">
            <div>
              <h3>販売商品</h3>
              <p>公開中 {overview.products.filter(p=>p.active===1).length} / {overview.limits.panelProductLimit}件。商品は「サービスから追加」で作ります。</p>
            </div>
            <button className="secondary" onClick={()=>setTab("services")}>サービスから追加</button>
          </div>
          {!overview.products.length&&<p>まだ商品がありません。</p>}
          <div className="list-stack">
            {overview.products.map(product=>{
              const live=product.live;
              const cost=live.found?live.rate:null;
              const editing=editingId===product.id&&draft;
              return (
                <div className="serverless-note" key={product.id}>
                  <strong>{product.emoji?product.emoji+" ":""}{product.name}{product.active===1?"":"(非公開)"}</strong>
                  <span>
                    サービスID {product.service_id} / 1000件 {yen(product.per1000)}
                    {cost!==null&&<> (原価 {yen(cost)} / {product.price_percent}%)</>}
                    {" "}/ 数量 {product.bounds?`${product.bounds.min.toLocaleString("ja-JP")}〜${product.bounds.max.toLocaleString("ja-JP")}`:"—"}
                    {" "}/ 販売 {product.sales_count}件
                  </span>
                  {!live.found&&<span className="shiire-muted">⚠ LuckyPanel側でサービスが見つかりません。この商品は購入できません。</span>}
                  {live.found&&!live.supported&&<span className="shiire-muted">⚠ 未対応のサービスタイプ({live.type})です。購入できません。</span>}
                  {editing&&draft?(
                    <>
                      <div className="form-grid two">
                        <label className="field"><span>商品名</span><input maxLength={80} value={draft.name} onChange={e=>setDraft({...draft,name:e.target.value})} /></label>
                        <label className="field"><span>絵文字</span><input maxLength={8} value={draft.emoji} onChange={e=>setDraft({...draft,emoji:e.target.value})} /></label>
                        <label className="field"><span>販売価格(原価の何%か・101以上)</span><input type="number" min={101} max={1000} value={draft.price_percent} onChange={e=>setDraft({...draft,price_percent:Number(e.target.value)})} /></label>
                        <label className="field"><span>最小数量</span><input type="number" min={1} value={draft.min_qty} onChange={e=>setDraft({...draft,min_qty:Number(e.target.value)})} /></label>
                        <label className="field"><span>最大数量(0で仕入れ先の上限)</span><input type="number" min={0} value={draft.max_qty} onChange={e=>setDraft({...draft,max_qty:Number(e.target.value)})} /></label>
                        <label className="field"><span>入力させるURL</span>
                          <select value={draft.link_kind} onChange={e=>setDraft({...draft,link_kind:e.target.value as LinkKind})}>
                            {(Object.keys(LINK_KIND_LABEL) as LinkKind[]).map(kind=><option key={kind} value={kind}>{LINK_KIND_LABEL[kind]}</option>)}
                          </select></label>
                      </div>
                      <label className="field"><span>説明(200文字まで)</span><input maxLength={200} value={draft.description} onChange={e=>setDraft({...draft,description:e.target.value})} /></label>
                      <div className="button-row">
                        <button className="primary" onClick={()=>void saveProduct(product)}>保存</button>
                        <button className="secondary" onClick={()=>{setEditingId("");setDraft(null);}}>キャンセル</button>
                      </div>
                    </>
                  ):(
                    <div className="button-row">
                      <button className="secondary" onClick={()=>{setEditingId(product.id);setDraft(draftFrom(product));}}>編集</button>
                      <button className="secondary" onClick={()=>void toggleProduct(product)}>{product.active===1?"非公開にする":"公開する"}</button>
                      <button className="danger" onClick={()=>void removeProduct(product)}>削除</button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {tab==="services"&&(
        <section className="card">
          <div className="section-head">
            <div>
              <h3>LuckyPanelのサービスから商品を追加</h3>
              <p>数量指定タイプ(Default)のサービスだけ販売できます。レートは1000件あたりの原価です。</p>
            </div>
            <button className="secondary" onClick={()=>void loadServices(true)}>最新を取得</button>
          </div>
          {servicesStale&&<div className="shiire-callout warn" role="status"><strong>最新の一覧を取得できず、保存済みの一覧を表示しています</strong></div>}
          <div className="form-grid two">
            <label className="field"><span>検索</span>
              <input value={query} placeholder="例: twitter フォロワー 日本人" onChange={e=>setQuery(e.target.value)} /></label>
            <label className="field"><span>カテゴリ</span>
              <select value={category} onChange={e=>setCategory(e.target.value)}>
                <option value="">すべて</option>
                {categories.map(item=><option key={item} value={item}>{item}</option>)}
              </select></label>
          </div>
          <label className="shiire-checkbox-row">
            <input type="checkbox" checked={onlySupported} onChange={e=>setOnlySupported(e.target.checked)} />
            <span>販売できるサービスだけ表示</span>
          </label>
          <p className="shiire-muted">{services?`${filteredServices.length.toLocaleString("ja-JP")}件${filteredServices.length>100?"(先頭100件を表示)":""}`:"読み込み中…"}</p>
          <div className="smm-table-wrap">
            <table className="smm-table">
              <thead><tr><th>ID</th><th>カテゴリ / 名前</th><th>原価/1000</th><th>数量</th><th></th></tr></thead>
              <tbody>
                {filteredServices.slice(0,100).map(service=>(
                  <tr key={service.service}>
                    <td>{service.service}</td>
                    <td><small>{service.category}</small><br />{service.name}{service.refill?" 🔁":""}</td>
                    <td>{yen(service.rate)}</td>
                    <td>{service.min.toLocaleString("ja-JP")}〜{service.max.toLocaleString("ja-JP")}</td>
                    <td><button className="secondary" disabled={!service.supported} onClick={()=>setCreating({
                      service,
                      draft:{
                        name:service.name.slice(0,80),description:"",emoji:"",
                        price_percent:130,min_qty:service.min||1,max_qty:0,
                        link_kind:guessLinkKind(service),active:true
                      }
                    })}>商品化</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {creating&&(
            <div className="serverless-note smm-create" role="dialog" aria-label="商品を追加">
              <strong>「{creating.service.name}」を商品にする</strong>
              <span>原価 {yen(creating.service.rate)}/1000 → 販売 {yen(Math.ceil(creating.service.rate*creating.draft.price_percent/100))}/1000</span>
              <div className="form-grid two">
                <label className="field"><span>商品名</span><input maxLength={80} value={creating.draft.name} onChange={e=>setCreating({...creating,draft:{...creating.draft,name:e.target.value}})} /></label>
                <label className="field"><span>絵文字</span><input maxLength={8} value={creating.draft.emoji} onChange={e=>setCreating({...creating,draft:{...creating.draft,emoji:e.target.value}})} /></label>
                <label className="field"><span>販売価格(原価の何%か・101以上)</span><input type="number" min={101} max={1000} value={creating.draft.price_percent} onChange={e=>setCreating({...creating,draft:{...creating.draft,price_percent:Number(e.target.value)}})} /></label>
                <label className="field"><span>最小数量</span><input type="number" min={1} value={creating.draft.min_qty} onChange={e=>setCreating({...creating,draft:{...creating.draft,min_qty:Number(e.target.value)}})} /></label>
                <label className="field"><span>最大数量(0で仕入れ先の上限)</span><input type="number" min={0} value={creating.draft.max_qty} onChange={e=>setCreating({...creating,draft:{...creating.draft,max_qty:Number(e.target.value)}})} /></label>
                <label className="field"><span>入力させるURL</span>
                  <select value={creating.draft.link_kind} onChange={e=>setCreating({...creating,draft:{...creating.draft,link_kind:e.target.value as LinkKind}})}>
                    {(Object.keys(LINK_KIND_LABEL) as LinkKind[]).map(kind=><option key={kind} value={kind}>{LINK_KIND_LABEL[kind]}</option>)}
                  </select></label>
              </div>
              <label className="field"><span>説明(200文字まで)</span><input maxLength={200} value={creating.draft.description} onChange={e=>setCreating({...creating,draft:{...creating.draft,description:e.target.value}})} /></label>
              <div className="button-row">
                <button className="primary" onClick={()=>void createProduct()}>この内容で追加</button>
                <button className="secondary" onClick={()=>setCreating(null)}>キャンセル</button>
              </div>
            </div>
          )}
        </section>
      )}

      {tab==="orders"&&(
        <section className="card">
          <div className="section-head">
            <div><h3>注文</h3><p>直近100件。要確認の注文は自動では再発注されません。</p></div>
            <label className="field"><span>状態</span>
              <select value={orderFilter} onChange={e=>setOrderFilter(e.target.value)}>
                <option value="">すべて</option>
                {Object.entries(STATUS_LABEL).map(([id,label])=><option key={id} value={id}>{label}</option>)}
              </select></label>
          </div>
          {!orders.length&&<p>該当する注文はありません。</p>}
          <div className="list-stack">
            {orders.map(order=>(
              <div className="serverless-note" key={order.id}>
                <strong>{STATUS_LABEL[order.status]??order.status} / {order.product_name} × {order.quantity.toLocaleString("ja-JP")} / {yen(order.total_amount)}</strong>
                <span>{when(order.created_at)} / 購入者 {order.user_id} / ID {order.id}</span>
                <span>対象 {order.link}</span>
                {order.supplier_order_id&&<span>LuckyPanel注文 #{order.supplier_order_id}{order.supplier_status?`(${order.supplier_status}`:""}{order.remains!==null&&order.supplier_status?` 残り${order.remains}`:""}{order.supplier_status?")":""}</span>}
                {order.last_error&&<span className="shiire-muted">⚠ {order.last_error}</span>}
                {order.refund_state==="required"&&<span className="shiire-muted">返金待ち {yen(order.refund_amount)}</span>}
                {order.refund_state==="done"&&<span className="shiire-muted">返金済み {yen(order.refund_amount)}</span>}
                <div className="button-row">
                  {order.status==="hold"&&!order.supplier_order_id&&(
                    <button className="secondary" onClick={()=>{
                      if(confirm("LuckyPanelの注文履歴でこの注文が作られていないことを確認しましたか?\n作られている場合は二重発注になります。")){
                        void orderAction(order,{action:"retry",confirmNotPlaced:true},"再発注しました");
                      }
                    }}>未発注を確認して再発注</button>
                  )}
                  {order.status==="hold"&&(
                    <button className="secondary" onClick={()=>{
                      const id=prompt("LuckyPanelの注文IDを入力してください");
                      if(id) void orderAction(order,{action:"link_supplier",supplierOrderId:id},"注文IDを紐付けました");
                    }}>LuckyPanel注文IDを紐付け</button>
                  )}
                  {order.status==="placed"&&(
                    <button className="secondary" onClick={()=>{
                      if(confirm("LuckyPanelにキャンセルを要求します。受理されると返金対象になります。")){
                        void orderAction(order,{action:"cancel_supplier"},"キャンセルを要求しました");
                      }
                    }}>LuckyPanelでキャンセル要求</button>
                  )}
                  {["paid","hold"].includes(order.status)&&(
                    <button className="danger" onClick={()=>{
                      if(confirm("この注文を失敗にして全額返金対象にします。LuckyPanel側で注文が存在しないことを確認してください。")){
                        void orderAction(order,{action:"fail_refund"},"返金対象にしました");
                      }
                    }}>失敗にして返金対象にする</button>
                  )}
                  {order.refund_state==="required"&&(
                    <button className="primary" onClick={()=>{
                      if(confirm(`購入者へ ${yen(order.refund_amount)} をPayPayで返金済みですか?`)){
                        void orderAction(order,{action:"refund_done"},"返金済みにしました");
                      }
                    }}>返金済みにする</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </fieldset>
  );
}
