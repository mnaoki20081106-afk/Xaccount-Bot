import { useEffect, useMemo, useState } from "react";
import { api } from "./api";

type Channel = { id:string; name:string };

type VendingPanelRow = {
  id:string;
  name:string;
  channelId:string|null;
  messageId:string|null;
  productCount:number;
  productNames:string[];
  totalStock:number;
  hasInfiniteStock:boolean;
  totalSales:number;
};

type ShiireProduct = {
  id:string;
  name:string;
  stock_count:number;
  sales_count:number;
  stockless_enabled:number;
};

type ShiireMachine = {
  id:string;
  name:string;
  active:number;
  products?:ShiireProduct[];
  panels?:Array<{channel_id:string;message_id:string}>;
};

type PanelRow = {
  key:string;
  bot:"自販機Bot"|"仕入れBot";
  machineId:string;
  name:string;
  channelIds:string[];
  messageUrl:string|null;
  productNames:string[];
  totalStock:number;
  hasUnlimitedStock:boolean;
  totalSales:number;
};

function channelLabel(channels:Channel[],id:string|null){
  if(!id) return null;
  const channel=channels.find(row=>row.id===id);
  return channel?"#"+channel.name:"#"+id;
}

export default function PanelOverview({
  guildId,
  channels,
  onError,
  onEditVending,
  onEditShiire
}:{
  guildId:string;
  channels:Channel[];
  onError:(reason:unknown)=>void;
  onEditVending:(machineId:string)=>void;
  onEditShiire:(machineId:string)=>void;
}){
  const [busy,setBusy]=useState(false);
  const [vendingRows,setVendingRows]=useState<VendingPanelRow[]>([]);
  const [shiireMachines,setShiireMachines]=useState<ShiireMachine[]>([]);
  const [filter,setFilter]=useState<"all"|"自販機Bot"|"仕入れBot">("all");
  const [loadError,setLoadError]=useState("");

  async function load(){
    setBusy(true);
    setLoadError("");
    try{
      const [vending,shiire]=await Promise.all([
        api<VendingPanelRow[]>(`/api/guilds/${guildId}/vending/panels`).catch(()=>[] as VendingPanelRow[]),
        api<ShiireMachine[]>(`/api/guilds/${guildId}/shiire/vending`).catch(()=>[] as ShiireMachine[])
      ]);
      setVendingRows(vending);
      setShiireMachines(shiire);
    }catch(reason){
      setLoadError(reason instanceof Error?reason.message:String(reason));
      onError(reason);
    }finally{
      setBusy(false);
    }
  }

  useEffect(()=>{void load()},[guildId]);

  const rows=useMemo<PanelRow[]>(()=>{
    const fromVending=vendingRows.map(row=>({
      key:"vending:"+row.id,
      bot:"自販機Bot" as const,
      machineId:row.id,
      name:row.name,
      channelIds:row.channelId?[row.channelId]:[],
      messageUrl:row.channelId&&row.messageId
        ?`https://discord.com/channels/${guildId}/${row.channelId}/${row.messageId}`
        :null,
      productNames:row.productNames,
      totalStock:row.totalStock,
      hasUnlimitedStock:row.hasInfiniteStock,
      totalSales:row.totalSales
    }));
    const fromShiire=shiireMachines.map(machine=>{
      const products=machine.products??[];
      const panels=machine.panels??[];
      return {
        key:"shiire:"+machine.id,
        bot:"仕入れBot" as const,
        machineId:machine.id,
        name:machine.name,
        channelIds:panels.map(panel=>panel.channel_id),
        messageUrl:panels.length===1
          ?`https://discord.com/channels/${guildId}/${panels[0]!.channel_id}/${panels[0]!.message_id}`
          :null,
        productNames:products.map(product=>product.name),
        totalStock:products.reduce((sum,product)=>sum+(product.stockless_enabled?0:product.stock_count),0),
        hasUnlimitedStock:products.some(product=>Boolean(product.stockless_enabled)),
        totalSales:products.reduce((sum,product)=>sum+(product.sales_count||0),0)
      };
    });
    return [...fromVending,...fromShiire].filter(row=>filter==="all"||row.bot===filter);
  },[vendingRows,shiireMachines,filter,guildId]);

  const totals=useMemo(()=>({
    panels:rows.length,
    installed:rows.filter(row=>row.channelIds.length>0).length,
    stock:rows.reduce((sum,row)=>sum+row.totalStock,0),
    sales:rows.reduce((sum,row)=>sum+row.totalSales,0)
  }),[rows]);

  return (
    <section className="card panel-overview">
      <div className="section-head">
        <div>
          <span className="eyebrow">PANEL OVERVIEW</span>
          <h2>パネル管理</h2>
          <p>
            「自販機」タブと「仕入れbot」タブに設置した自販機パネルを、設置Bot・商品・在庫・販売数ごとに一覧で確認できます。
            編集はそれぞれのタブで行うため、ここから直接ジャンプできます。
          </p>
        </div>
        <button className="secondary" onClick={()=>void load()} disabled={busy}>
          再読み込み
        </button>
      </div>

      <div className="metric-grid">
        <article className="metric card">
          <span>自販機パネル</span>
          <strong>{totals.panels}</strong>
          <small>自販機Bot + 仕入れBot</small>
        </article>
        <article className="metric card">
          <span>Discordに設置済み</span>
          <strong>{totals.installed}</strong>
          <small>未設置を除く件数</small>
        </article>
        <article className="metric card">
          <span>合計在庫</span>
          <strong>{totals.stock}</strong>
          <small>無在庫販売の商品は含みません</small>
        </article>
        <article className="metric card">
          <span>累計販売数</span>
          <strong>{totals.sales}</strong>
          <small>全パネル合計</small>
        </article>
      </div>

      <div className="button-row panel-overview-filter" role="tablist" aria-label="Botで絞り込み">
        {(["all","自販機Bot","仕入れBot"] as const).map(value=>(
          <button
            key={value}
            type="button"
            className="secondary"
            aria-pressed={filter===value}
            onClick={()=>setFilter(value)}
          >
            {value==="all"?"すべて":value}
          </button>
        ))}
      </div>

      {loadError&&<div className="alert error">{loadError}</div>}

      <div className="panel-overview-list">
        {rows.length===0&&!busy&&(
          <p className="muted">
            まだ自販機パネルがありません。「自販機」タブか「仕入れbot」タブで作成してください。
          </p>
        )}
        {rows.map(row=>(
          <article key={row.key} className="card panel-overview-row">
            <div className="panel-overview-row-head">
              <span className={`panel-overview-bot-badge ${row.bot==="自販機Bot"?"vending":"shiire"}`}>
                {row.bot}
              </span>
              <strong>{row.name}</strong>
              {row.channelIds.length===0&&(
                <span className="panel-overview-unlisted">未設置</span>
              )}
            </div>
            <div className="panel-overview-row-body">
              <span>
                設置先:{" "}
                {row.channelIds.length
                  ?row.channelIds.map(id=>channelLabel(channels,id)).join(", ")
                  :"—"}
              </span>
              <span>
                商品: {row.productNames.length?row.productNames.join(" / "):"未設定"}
              </span>
              <span>
                在庫: {row.totalStock}{row.hasUnlimitedStock?"（無在庫販売あり）":""} / 販売数: {row.totalSales}
              </span>
            </div>
            <div className="button-row">
              {row.messageUrl&&(
                <a className="secondary" href={row.messageUrl} target="_blank" rel="noreferrer">
                  Discordで開く
                </a>
              )}
              <button
                className="primary"
                onClick={()=>
                  row.bot==="自販機Bot"
                    ?onEditVending(row.machineId)
                    :onEditShiire(row.machineId)
                }
              >
                {row.bot}タブで編集
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
