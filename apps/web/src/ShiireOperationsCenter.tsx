import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import ShiireVendingManager from "./ShiireVendingManager";
import "./shiire-operations.css";

type Channel={id:string;name:string;type?:string};
type Role={id:string;name:string;position:number;isEveryone:boolean};
type Section="overview"|"funding"|"procurement"|"inventory"|"vending"|"logs";
type Settled<T>={ok:true;data:T}|{ok:false;error:string};

type Overview={
  generatedAt:number;
  safety:{
    dryRun:boolean;
    emergencyStop:boolean;
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

const sections:Array<{id:Section;label:string;hint:string}>=[
  {id:"overview",label:"概要",hint:"今の状態"},
  {id:"funding",label:"資金・LTC",hint:"残高と送金"},
  {id:"procurement",label:"仕入れ",hint:"商品と注文"},
  {id:"inventory",label:"在庫",hint:"カテゴリ別"},
  {id:"vending",label:"自販機・設定",hint:"設置と通知"},
  {id:"logs",label:"ログ・障害",hint:"監査とBreaker"}
];

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
  const [overview,setOverview]=useState<Overview|null>(null);
  const [binance,setBinance]=useState<BinanceDetail|null>(null);
  const [hstora,setHstora]=useState<HstoraDetail|null>(null);
  const [inventory,setInventory]=useState<InventoryDetail|null>(null);
  const [orders,setOrders]=useState<OrderDetail|null>(null);
  const [logs,setLogs]=useState<LogDetail|null>(null);
  const [busy,setBusy]=useState(false);
  const [detailBusy,setDetailBusy]=useState(false);

  const funding=settledData(overview?.funding);
  const ltc=settledData(overview?.balances.binanceLtc);
  const jpy=settledData(overview?.balances.binanceJpy);
  const hstoraBalance=settledData(overview?.balances.hstora);
  const market=settledData(overview?.market);
  const topReady=classReady(overview,"TOP_SEARCH");
  const topReserved=classReserved(overview,"TOP_SEARCH");
  const shadowReady=classReady(overview,"NO_SHADOWBAN");
  const shadowReserved=classReserved(overview,"NO_SHADOWBAN");
  const blockers=
    (overview?.circuitBreakers?.length??0)+
    (overview?.recentErrors?.length??0)+
    (overview?.providerIssues?.length??0);

  const overallState=useMemo(()=>{
    if(!overview) return {label:"読込中",tone:"warn",detail:"Discord-Shiireの状態を取得しています"};
    if(overview.safety.emergencyStop){
      return {label:"緊急停止",tone:"bad",detail:"自動購入・自動仕入れは停止されています"};
    }
    if(overview.circuitBreakers.length){
      return {label:"要確認",tone:"bad",detail:"Circuit Breakerが開いています"};
    }
    if(overview.providerIssues?.length){
      return {
        label:"API要確認",
        tone:"bad",
        detail:"外部Providerの取得に失敗しています。残高が「—」のままでも正常扱いにしません"
      };
    }
    if(overview.safety.dryRun){
      return {label:"DRY RUN",tone:"good",detail:"เงินจริงを動かさない安全モードです"};
    }
    if(!overview.safety.autoProcurementEnabled){
      return {label:"待機",tone:"warn",detail:"LIVE設定ですが自動仕入れはOFFです"};
    }
    return {label:"自動運転",tone:"good",detail:"設定範囲内で自動仕入れが有効です"};
  },[overview]);

  async function loadOverview(showBusy=true){
    if(showBusy) setBusy(true);
    try{
      const data=await api<Overview>(
        `/api/guilds/${guildId}/shiire/operations/overview`,
        {},
        25_000
      );
      setOverview(data);
    }catch(reason){
      onError(reason);
    }finally{
      if(showBusy) setBusy(false);
    }
  }

  async function loadDetail(target:Section){
    if(target==="overview"||target==="vending") return;
    setDetailBusy(true);
    try{
      if(target==="funding"){
        const data=await api<BinanceDetail>(
          `/api/guilds/${guildId}/shiire/operations/binance`,
          {},
          25_000
        );
        setBinance(data);
      }else if(target==="procurement"){
        const [nextOrders,nextHstora]=await Promise.all([
          api<OrderDetail>(
            `/api/guilds/${guildId}/shiire/operations/orders`,
            {},
            20_000
          ),
          api<HstoraDetail>(
            `/api/guilds/${guildId}/shiire/operations/hstora`,
            {},
            25_000
          )
        ]);
        setOrders(nextOrders);
        setHstora(nextHstora);
      }else if(target==="inventory"){
        setInventory(await api<InventoryDetail>(
          `/api/guilds/${guildId}/shiire/operations/inventory`,
          {},
          20_000
        ));
      }else if(target==="logs"){
        setLogs(await api<LogDetail>(
          `/api/guilds/${guildId}/shiire/operations/logs`,
          {},
          20_000
        ));
      }
    }catch(reason){
      onError(reason);
    }finally{
      setDetailBusy(false);
    }
  }

  useEffect(()=>{
    setOverview(null);
    setBinance(null);
    setHstora(null);
    setInventory(null);
    setOrders(null);
    setLogs(null);
    setSection("overview");
    void loadOverview();
  },[guildId]);

  useEffect(()=>{
    if(section!=="overview"&&section!=="vending") void loadDetail(section);
  },[section]);

  async function refresh(){
    await loadOverview();
    if(section!=="overview"&&section!=="vending") await loadDetail(section);
    onNotice("仕入れbotの運用情報を更新しました");
  }

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
            <span className="eyebrow">DISCORD-SHIIRE OPERATIONS</span>
            <div className="shiire-title-row">
              <h2>仕入れbot 運用センター</h2>
              <span className={`shiire-health ${overallState.tone}`}>
                <i />{overallState.label}
              </span>
            </div>
            <p>{overallState.detail}</p>
          </div>
          <button className="secondary" onClick={()=>void refresh()} disabled={busy||detailBusy}>
            {busy||detailBusy?"更新中…":"すべて更新"}
          </button>
        </div>
        <div className="shiire-safety-strip">
          <span className={overview?.safety.dryRun?"safe":"live"}>
            {overview?.safety.dryRun?"DRY RUN":"LIVE"}
          </span>
          <span>自動仕入れ {overview?.safety.autoProcurementEnabled?"ON":"OFF"}</span>
          <span>LTC自動購入 {overview?.safety.autoPurchaseEnabled?"ON":"OFF"}</span>
          <span>更新 {when(overview?.generatedAt)}</span>
        </div>
      </section>

      <nav className="shiire-subnav" aria-label="仕入れbot管理メニュー">
        {sections.map(item=>(
          <button
            type="button"
            key={item.id}
            className={section===item.id?"active":""}
            onClick={()=>setSection(item.id)}
          >
            <strong>{item.label}</strong>
            <small>{item.hint}</small>
          </button>
        ))}
      </nav>

      {(busy&&!overview)&&<div className="progress"><span /></div>}

      {section==="overview"&&(
        <>
          <section className="shiire-kpi-grid">
            <article className="card shiire-kpi">
              <span>PAYPAY 使用可能額</span>
              <strong>{yen(payPayAllowed)}</strong>
              <small>
                観測 {yen(funding?.observedPayPay?.effectiveBalanceJpy)}
                {funding?.observedPayPay?.fresh?" / 最新":" / 要更新"}
              </small>
            </article>
            <article className="card shiire-kpi">
              <span>BINANCE LTC</span>
              <strong>{num(Number(ltc?.free??0)+Number(ltc?.locked??0),8)} LTC</strong>
              <small>Free {num(ltc?.free,8)} / Locked {num(ltc?.locked,8)}</small>
            </article>
            <article className="card shiire-kpi">
              <span>HSTORA 残高</span>
              <strong>{usd(hstoraBalance?.balance)}</strong>
              <small>Pending {usd(hstoraBalance?.pending_balance)}</small>
            </article>
            <article className="card shiire-kpi">
              <span>LTC / JPY</span>
              <strong>{yen(market?.priceJpy)}</strong>
              <small>公式市場データ</small>
            </article>
            <article className="card shiire-kpi accent">
              <span>TOP_SEARCH 在庫</span>
              <strong>{topReady}</strong>
              <small>予約中 {topReserved} / 目標 {num(topPolicy.target,0)}</small>
            </article>
            <article className="card shiire-kpi accent">
              <span>NO_SHADOWBAN 在庫</span>
              <strong>{shadowReady}</strong>
              <small>予約中 {shadowReserved} / 目標 {num(shadowPolicy.target,0)}</small>
            </article>
            <article className="card shiire-kpi">
              <span>本日の仕入れ</span>
              <strong>{num(overview?.today.count,0)}件</strong>
              <small>{overview?.today.approximateJpy==null?usd(overview?.today.amount):yen(overview?.today.approximateJpy)}</small>
            </article>
            <article className={`card shiire-kpi ${blockers?"danger-card":""}`}>
              <span>障害・要確認</span>
              <strong>{blockers}</strong>
              <small>Breaker {overview?.circuitBreakers.length??0} / Error {overview?.recentErrors.length??0}</small>
            </article>
          </section>

          <section className="two-col shiire-overview-grid">
            <article className="card">
              <div className="section-head">
                <div>
                  <span className="eyebrow">STOCK HEALTH</span>
                  <h2>在庫と補充ライン</h2>
                </div>
              </div>
              <div className="shiire-stock-lines">
                <StockLine
                  label="検索トップ"
                  ready={topReady}
                  reserved={topReserved}
                  reorder={Number(topPolicy.reorder??0)}
                  target={Number(topPolicy.target??0)}
                  limit={topPolicy.max==null?"—":yen(topPolicy.max)}
                />
                <StockLine
                  label="No Shadowban"
                  ready={shadowReady}
                  reserved={shadowReserved}
                  reorder={Number(shadowPolicy.reorder??0)}
                  target={Number(shadowPolicy.target??0)}
                  limit={shadowPolicy.max==null?"—":usd(shadowPolicy.max)}
                />
              </div>
            </article>

            <article className="card">
              <div className="section-head">
                <div>
                  <span className="eyebrow">SYSTEM HEALTH</span>
                  <h2>連携状態</h2>
                </div>
              </div>
              <div className="shiire-health-list">
                <HealthRow label="HStora API" ok={Boolean(overview?.integrations.hstoraConfigured)} />
                <HealthRow label="Binance 取引API" ok={Boolean(overview?.integrations.binanceTradeConfigured)} />
                <HealthRow
                  label="Binance 出金"
                  ok={Boolean(withdrawal?.readyForLiveWithdrawal)}
                  detail={withdrawal?.readyForLiveWithdrawal?"LIVE出金条件OK":"未設定または安全条件未達"}
                />
                <HealthRow
                  label="暗号化キー"
                  ok={Boolean(overview?.integrations.credentialsEncryptionConfigured)}
                />
                <HealthRow
                  label="専用LTC Wallet"
                  ok={false}
                  neutral
                  detail="未接続（秘密鍵をWorkerへ保存しない設計）"
                />
              </div>
            </article>
          </section>

          <section className="two-col">
            <article className="card">
              <span className="eyebrow">RECENT PROCUREMENT</span>
              <h2>直近の仕入れ注文</h2>
              <OrderList rows={overview?.recentOrders??[]} compact />
            </article>
            <article className="card">
              <span className="eyebrow">ATTENTION</span>
              <h2>最近の異常</h2>
              {(overview?.circuitBreakers.length??0)===0&&
                (overview?.recentErrors.length??0)===0&&
                (overview?.providerIssues.length??0)===0
                ?<div className="shiire-empty">現在、Provider障害・開いているBreaker・直近エラーはありません。</div>
                :<>
                  {(overview?.providerIssues??[]).slice(0,5).map((row)=>(
                    <div className="shiire-event danger" key={"provider:"+row.provider}>
                      <strong>{row.provider} API</strong>
                      <span>{row.error}</span>
                    </div>
                  ))}
                  {(overview?.circuitBreakers??[]).slice(0,5).map((row:any)=>(
                    <div className="shiire-event danger" key={"breaker:"+row.key}>
                      <strong>{row.key}</strong>
                      <span>{row.reason||"Circuit Breaker OPEN"}</span>
                    </div>
                  ))}
                  {(overview?.recentErrors??[]).slice(0,5).map((row:any)=>(
                    <div className="shiire-event" key={row.id}>
                      <strong>{row.kind}</strong>
                      <span>{row.message}</span>
                      <small>{when(row.created_at)}</small>
                    </div>
                  ))}
                </>
              }
            </article>
          </section>
        </>
      )}

      {section==="funding"&&(
        <>
          {detailBusy&&!binance&&<div className="progress"><span /></div>}
          <section className="shiire-kpi-grid">
            <article className="card shiire-kpi">
              <span>PayPay 観測残高</span>
              <strong>{yen(funding?.observedPayPay?.balanceJpy)}</strong>
              <small>{funding?.observedPayPay?.fresh?"観測値は有効":"観測値が古い / 未設定"}</small>
            </article>
            <article className="card shiire-kpi">
              <span>今回の購入可能額</span>
              <strong>{yen(payPayAllowed)}</strong>
              <small>{funding?.allowance?.blockedReason||"各上限の最小値"}</small>
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

          {pendingFunding&&(
            <section className="card shiire-callout warn">
              <strong>PayPay → Binance 手動操作待ち</strong>
              <span>
                最大 {yen(pendingFunding.amountJpy)} をPayPay残高から予約中です。
                BOTはBinanceの実残高増加を検知して再開します。
              </span>
              {Number(pendingFunding.jpyDepositGrossJpy??0)>0&&(
                <span>
                  JPY即時入金: PayPayから {yen(pendingFunding.jpyDepositGrossJpy)} 支払い →
                  Binance JPYが最低 {yen(pendingFunding.expectedJpyCreditJpy)} 増えれば完了扱い。
                  現行の110円入金手数料を織り込み済みです。
                </span>
              )}
              {Number(pendingFunding.directLtcBudgetJpy??0)>0&&(
                <span>
                  LTC直接購入: {yen(pendingFunding.directLtcBudgetJpy)} 分を
                  Binance公式PayPay購入画面で購入する経路も利用できます。
                </span>
              )}
            </section>
          )}

          <section className="two-col">
            <article className="card">
              <span className="eyebrow">SPENDING LIMITS</span>
              <h2>資金上限</h2>
              <div className="shiire-detail-grid">
                <Detail label="reserve_jpy" value={yen(overview?.settings.reserve_jpy)} />
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
                <HealthRow label="LIVE出金可能" ok={Boolean(withdrawal?.readyForLiveWithdrawal)} />
                <HealthRow
                  label="ホワイトリスト"
                  ok={Number(withdrawal?.allowlistedLtcAddressCount??0)>0}
                  detail={(withdrawal?.allowlistedLtcAddressCount??0)+"件"}
                />
              </div>
            </article>
          </section>

          <section className="two-col">
            <article className="card">
              <span className="eyebrow">BINANCE DETAIL</span>
              <h2>Binance Japan</h2>
              <div className="shiire-detail-grid">
                <Detail label="LTC Free" value={num(settledData(binance?.balances.ltc)?.free,8)+" LTC"} />
                <Detail label="LTC Locked" value={num(settledData(binance?.balances.ltc)?.locked,8)+" LTC"} />
                <Detail label="JPY Free" value={yen(settledData(binance?.balances.jpy)?.free)} />
                <Detail label="LTC/JPY" value={yen(settledData(binance?.market)?.priceJpy)} />
              </div>
            </article>
            <article className="card">
              <span className="eyebrow">HOT WALLET</span>
              <h2>専用LTC Wallet</h2>
              <div className="shiire-callout neutral">
                <strong>現在は未接続</strong>
                <span>{String(hotWallet?.health?.details?.reason??"専用署名ウォレットはまだ接続されていません。")}</span>
              </div>
              <div className="shiire-detail-grid">
                <Detail label="目標LTC" value={num(overview?.settings.wallet_target_ltc,8)} />
                <Detail label="最大LTC" value={num(overview?.settings.wallet_max_ltc,8)} />
                <Detail label="実残高" value={hotWallet?.balanceLtc==null?"未取得":num(hotWallet.balanceLtc,8)+" LTC"} />
              </div>
            </article>
          </section>
        </>
      )}

      {section==="procurement"&&(
        <>
          {detailBusy&&!orders&&<div className="progress"><span /></div>}
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
        </>
      )}

      {section==="inventory"&&(
        <>
          {detailBusy&&!inventory&&<div className="progress"><span /></div>}
          <section className="two-col">
            <InventoryClassCard
              title="TOP_SEARCH"
              values={inventory?.byClass?.TOP_SEARCH??overview?.inventoryByClass?.TOP_SEARCH??{}}
              target={Number(topPolicy.target??0)}
            />
            <InventoryClassCard
              title="NO_SHADOWBAN"
              values={inventory?.byClass?.NO_SHADOWBAN??overview?.inventoryByClass?.NO_SHADOWBAN??{}}
              target={Number(shadowPolicy.target??0)}
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
          <section className="two-col">
            <article className="card">
              <span className="eyebrow">CIRCUIT BREAKERS</span>
              <h2>停止中の安全装置</h2>
              {(logs?.breakers??overview?.circuitBreakers??[]).length===0
                ?<div className="shiire-empty">開いているCircuit Breakerはありません。</div>
                :(logs?.breakers??overview?.circuitBreakers??[]).map((row:any)=>(
                  <div className="shiire-event danger" key={row.key}>
                    <strong>{row.key}</strong>
                    <span>{row.reason||"OPEN"}</span>
                    <small>{when(row.updated_at)}</small>
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
                    label={key}
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

function HealthRow({
  label,ok,detail,neutral=false
}:{label:string;ok:boolean;detail?:string;neutral?:boolean}){
  const tone=neutral?"neutral":statusTone(ok);
  return <div className="shiire-health-row">
    <span className={`shiire-dot ${tone}`} />
    <div><strong>{label}</strong>{detail&&<small>{detail}</small>}</div>
    <b>{neutral?"N/A":ok?"OK":"CHECK"}</b>
  </div>;
}

function StockLine({
  label,ready,reserved,reorder,target,limit
}:{label:string;ready:number;reserved:number;reorder:number;target:number;limit:string}){
  const total=ready+reserved;
  const ratio=target>0?Math.min(100,total/target*100):0;
  const low=total<=reorder;
  return <div className="shiire-stock-line">
    <div className="shiire-stock-head">
      <strong>{label}</strong>
      <span className={low?"low":""}>{total} / {target}</span>
    </div>
    <div className="shiire-stock-bar"><i style={{width:ratio+"%"}} /></div>
    <small>販売可 {ready} / 予約中 {reserved} / 発注点 {reorder} / 上限 {limit}</small>
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
  return <span className={`shiire-class-badge ${cls}`}>{text}</span>;
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
          <b>{row.status}</b>
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
