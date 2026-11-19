import { useEffect, useState } from "react";
import { api } from "./api";
import {
  ConsoleChannel, Icon, Loading, channelName, errorText, yen
} from "./console-ui";

type Summary = {
  machineCount:number;
  productCount:number;
  finiteStock:number;
  infiniteProducts:number;
  emptyProducts:number;
  deliveredOrders:number;
  paidOrders:number;
  freeOrders:number;
  revenueYen:number;
  installedPanels:number;
};

type PanelRow = {
  id:string;
  name:string;
  channelId:string|null;
  messageId:string|null;
  productCount:number;
  totalStock:number;
  hasInfiniteStock:boolean;
  totalSales:number;
};

export type ConsoleView =
  | "overview" | "vending" | "stock" | "coupons" | "payments" | "assets" | "panels"
  | "server" | "tickets" | "verification" | "members" | "security" | "backup"
  | "shiire" | "affiliate" | "followbomb" | "utility" | "generator";

export default function DashboardOverview({
  guildId, channels, onNavigate, onEditVending, onEditShiire, onNotice, onError
}:{
  guildId:string;
  channels:ConsoleChannel[];
  onNavigate:(view:ConsoleView)=>void;
  onEditVending:(machineId:string)=>void;
  onEditShiire:(machineId:string)=>void;
  onNotice:(message:string)=>void;
  onError:(reason:unknown)=>void;
}){
  const [summary,setSummary]=useState<Summary|null>(null);
  const [panels,setPanels]=useState<PanelRow[]>([]);
  const [payments,setPayments]=useState<{paypay:boolean;kyash:boolean}|null>(null);
  const [busy,setBusy]=useState(false);
  const [loadError,setLoadError]=useState<string|null>(null);
  const [loaded,setLoaded]=useState(false);

  async function load(){
    await loadOwn();
  }

  async function loadOwn(){
    setBusy(true);
    setLoadError(null);
    try{
      const [nextSummary,nextPanels,nextPayments]=await Promise.all([
        api<Summary>(`/api/guilds/${guildId}/vending/dashboard-summary`),
        api<PanelRow[]>(`/api/guilds/${guildId}/vending/panels`),
        api<{paypay:boolean;kyash:boolean}>("/api/vending/payments/status")
      ]);
      setSummary(nextSummary);
      setPanels(nextPanels);
      setPayments(nextPayments);
    }catch(reason){
      setLoadError(errorText(reason));
    }finally{
      setBusy(false);
      setLoaded(true);
    }
  }

  useEffect(()=>{ void load(); },[guildId]);

  async function refreshPanel(row:PanelRow){
    if(!row.channelId||!row.messageId) return;
    setBusy(true);
    try{
      await api(`/api/guilds/${guildId}/vending/${row.id}/panel/update`,{
        method:"POST",
        body:JSON.stringify({messageUrl:`https://discord.com/channels/${guildId}/${row.channelId}/${row.messageId}`})
      });
      onNotice(row.name+" のパネルを最新状態に更新しました");
    }catch(reason){ onError(reason); }
    finally{ setBusy(false); }
  }

  async function syncCommands(){
    setBusy(true);
    try{
      await api("/api/commands/register",{method:"POST"});
      onNotice("スラッシュコマンドを再同期しました");
    }catch(reason){ onError(reason); }
    finally{ setBusy(false); }
  }

  return (
    <>
      <section className="xc-card hero">
        <h1>自販機 &amp; サーバー 管理システム</h1>
        <p>
          Xaccount-Botの自販機・商品在庫・チケット・PayPay/Kyash決済・パネルをWebから管理・更新できます。
          仕入れbot / X-Utility など別Botの機能も、このサイドバーからまとめて操作できます。
        </p>
      </section>

      {loadError&&<div className="alert error">概要データの取得に失敗しました: {loadError}</div>}
      {!loaded&&<Loading label="概要を読み込み中…" />}

      <section className="xc-stat-grid" aria-label="主要な数値">
        <article className="xc-stat gold">
          <span>自販機 総売上額</span>
          <strong>{summary?yen(summary.revenueYen):"—"}</strong>
          <small>納品完了した注文の合計</small>
        </article>
        <article className="xc-stat cyan">
          <span>自販機数</span>
          <strong>{summary?.machineCount??"—"}</strong>
          <small>Xaccount-Botの自販機</small>
        </article>
        <article className="xc-stat cyan">
          <span>総商品数</span>
          <strong>{summary?.productCount??"—"}</strong>
          <small>登録済みアイテム</small>
        </article>
        <article className="xc-stat teal">
          <span>総在庫数</span>
          <strong>{summary?summary.finiteStock:"—"}</strong>
          <small>即時納品可能{summary&&summary.infiniteProducts>0?` ＋ 常時販売 ${summary.infiniteProducts}品`:""}</small>
        </article>
        <article className={`xc-stat ${summary&&summary.emptyProducts>0?"red":"violet"}`}>
          <span>在庫切れ</span>
          <strong>{summary?summary.emptyProducts+"品":"—"}</strong>
          <small>補充が必要な商品</small>
        </article>
        <article className={`xc-stat ${payments?.paypay?"green":"red"}`}>
          <span>PayPay</span>
          <strong>● {payments?(payments.paypay?"連携中（有効）":"未接続"):"—"}</strong>
          <small>{payments?.paypay?"決済受付稼働中":"PayPay設定から接続"}</small>
        </article>
        <article className={`xc-stat ${payments?.kyash?"green":"red"}`}>
          <span>Kyash</span>
          <strong>● {payments?(payments.kyash?"連携中（有効）":"未接続"):"—"}</strong>
          <small>{payments?.kyash?"決済受付稼働中":"PayPay設定から接続"}</small>
        </article>
      </section>

      <section className="xc-card">
        <div className="xc-section-title">
          <span className="xc-section-icon"><Icon name="check" /></span>
          <div>
            <h2>実績ログ &amp; 売上カウンター</h2>
            <p>Xaccount-Bot自販機で納品完了まで進んだ注文から自動集計します（仕入れbotの売上は含みません）。</p>
          </div>
        </div>
        <div className="xc-ledger">
          <span className="gold">累計売上 <b>{summary?yen(summary.revenueYen):"—"}</b></span>
          <span>全体実績: <b>{summary?.deliveredOrders??"—"}</b></span>
          <span className="teal">有料実績: <b>{summary?.paidOrders??"—"}</b></span>
          <span className="cyan">無料実績: <b>{summary?.freeOrders??"—"}</b></span>
        </div>
      </section>

      <section className="xc-card">
        <div className="xc-section-title">
          <span className="xc-section-icon" style={{color:"#a99fff",background:"#1a1840",borderColor:"#3a2f7a"}}><Icon name="bolt" /></span>
          <div><h2>クイックアクション（Discord即時反映）</h2></div>
        </div>
        <div className="xc-quick-grid">
          <button type="button" className="xc-quick" onClick={()=>onNavigate("vending")}>
            <strong>🏪 自販機パネル設置 / 更新</strong>
            <small>画像付き自販機パネルのDiscord送信・更新</small>
          </button>
          <button type="button" className="xc-quick accent" onClick={()=>onNavigate("assets")}>
            <strong>🖼 アセット（パネル作成）</strong>
            <small>案内・規約などのEmbedパネルを作成して設置</small>
          </button>
          <button type="button" className="xc-quick" onClick={()=>onNavigate("server")}>
            <strong>🔀 チャンネル位置エディタ</strong>
            <small>Discordのカテゴリー・チャンネルの並び順・階層を編集</small>
          </button>
          <button type="button" className="xc-quick" onClick={()=>onNavigate("stock")}>
            <strong>📦 在庫エディタ</strong>
            <small>全自販機の在庫を一覧で確認・補充</small>
          </button>
          <button type="button" className="xc-quick" disabled={busy} onClick={()=>void syncCommands()}>
            <strong>🔄 コマンド同期</strong>
            <small>スラッシュコマンドをDiscordへ再登録</small>
          </button>
        </div>
      </section>

      <section className="xc-card">
        <div className="xc-page-head" style={{marginBottom:14}}>
          <h2 style={{margin:0,fontSize:20}}>自販機一覧プレビュー</h2>
          <button type="button" className="xc-btn ghost tiny" onClick={()=>onNavigate("vending")}>すべて見る →</button>
        </div>
        <div className="xc-table-wrap">
          <table className="xc-table">
            <thead>
              <tr>
                <th>自販機名</th><th>Bot</th><th>稼働状況</th><th>設置位置</th>
                <th>商品数</th><th>総在庫数</th><th>販売数</th><th>操作</th>
              </tr>
            </thead>
            <tbody>
              {panels.map(row=>(
                <tr key={"vm:"+row.id}>
                  <td><span className="xc-name">{row.name}</span></td>
                  <td><span className="xc-pill violet">Xaccount-Bot</span></td>
                  <td>{row.channelId
                    ?<span className="xc-pill green">● 稼働中</span>
                    :<span className="xc-pill gray">未設置</span>}</td>
                  <td>{row.channelId?<span style={{color:"#9aa5ff"}}>#{channelName(channels,row.channelId)}</span>:<span className="muted">—</span>}</td>
                  <td>{row.productCount} 件</td>
                  <td style={{color:"#2fd39a",fontWeight:800}}>{row.totalStock} 個{row.hasInfiniteStock?" ＋∞":""}</td>
                  <td>{row.totalSales}</td>
                  <td className="actions">
                    {row.channelId&&row.messageId&&(
                      <button type="button" className="xc-btn tiny stock" disabled={busy} onClick={()=>void refreshPanel(row)}>パネル更新</button>
                    )}
                    <button type="button" className="xc-btn tiny edit" onClick={()=>onEditVending(row.id)}>管理</button>
                  </td>
                </tr>
              ))}
              {loaded&&panels.length===0&&(
                <tr><td colSpan={8} className="xc-empty">まだ自販機がありません。「自販機 &amp; 商品管理」から作成してください。</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
