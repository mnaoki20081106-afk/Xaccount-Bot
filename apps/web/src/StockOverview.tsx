import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { Loading, ShiireMachineRow, VmDetail, VmMachine, errorText } from "./console-ui";

type Row = {
  key:string;
  bot:"xaccount"|"shiire";
  machineId:string;
  machineName:string;
  productId:string;
  productName:string;
  emoji:string|null;
  stock:number;
  infinite:boolean;
  stockless:boolean;
  sales:number;
};

const LOW_STOCK=5;

/** Read-first stock board across every vending machine of both bots. */
export default function StockOverview({
  guildId, onOpenProduct, onEditShiire, onError
}:{
  guildId:string;
  onOpenProduct:(machineId:string,productId:string)=>void;
  onEditShiire:(machineId:string)=>void;
  onError:(reason:unknown)=>void;
}){
  const [ownRows,setOwnRows]=useState<Row[]>([]);
  const [shiireRows,setShiireRows]=useState<Row[]>([]);
  const [shiireLoading,setShiireLoading]=useState(true);
  const rows=useMemo(()=>[...ownRows,...shiireRows],[ownRows,shiireRows]);
  const [busy,setBusy]=useState(false);
  const [filter,setFilter]=useState<"all"|"empty"|"low"|"infinite"|"shiire">("all");
  const [query,setQuery]=useState("");
  const [shiireError,setShiireError]=useState<string|null>(null);

  // Own machines and the 仕入れbot (a separate, slower worker) load in parallel
  // and each part is shown as soon as it arrives.
  async function loadOwn(){
    setBusy(true);
    try{
      const machines=await api<VmMachine[]>(`/api/guilds/${guildId}/vending`);
      const details=await Promise.all(machines.map(machine=>api<VmDetail>(`/api/guilds/${guildId}/vending/${machine.id}`)));
      setOwnRows(details.flatMap(detail=>detail.products.map(product=>({
        key:"vm:"+product.id,bot:"xaccount" as const,machineId:detail.id,machineName:detail.name,
        productId:product.id,productName:product.name,emoji:product.emoji,
        stock:product.infinite_stock?0:product.stock_count,infinite:Boolean(product.infinite_stock),
        stockless:false,sales:product.sales_count
      }))));
    }catch(reason){ onError(reason); }
    finally{ setBusy(false); }
  }
  async function loadShiire(){
    setShiireLoading(true);
    try{
      const shiire=await api<ShiireMachineRow[]>(`/api/guilds/${guildId}/shiire/vending`,{},30_000);
      setShiireRows(shiire.flatMap(machine=>(machine.products??[]).map(product=>({
        key:"shiire:"+product.id,bot:"shiire" as const,machineId:machine.id,machineName:machine.name,
        productId:product.id,productName:product.name,emoji:product.emoji,
        stock:product.stock_count,infinite:false,stockless:Boolean(product.stockless_enabled),sales:product.sales_count
      }))));
      setShiireError(null);
    }catch(reason){ setShiireError(errorText(reason)); }
    finally{ setShiireLoading(false); }
  }
  async function load(){
    await Promise.all([loadOwn(),loadShiire()]);
  }

  useEffect(()=>{ void load(); },[guildId]);

  const totals=useMemo(()=>({
    products:rows.length,
    stock:rows.reduce((sum,row)=>sum+row.stock,0),
    empty:rows.filter(row=>!row.infinite&&row.stock===0).length,
    low:rows.filter(row=>!row.infinite&&row.stock>0&&row.stock<=LOW_STOCK).length
  }),[rows]);

  const maxStock=Math.max(1,...rows.map(row=>row.stock));
  const visible=rows.filter(row=>{
    if(query&&!(row.productName+" "+row.machineName).toLowerCase().includes(query.toLowerCase())) return false;
    if(filter==="empty") return !row.infinite&&row.stock===0;
    if(filter==="low") return !row.infinite&&row.stock>0&&row.stock<=LOW_STOCK;
    if(filter==="infinite") return row.infinite;
    if(filter==="shiire") return row.bot==="shiire";
    return true;
  }).sort((a,b)=>Number(b.stock===0&&!b.infinite)-Number(a.stock===0&&!a.infinite)||a.stock-b.stock);

  return (
    <>
      <div className="xc-page-head">
        <div>
          <h1>在庫エディタ</h1>
          <p>全自販機の在庫を一覧で確認できます。在庫切れ・残りわずかの商品が上に表示されます。</p>
        </div>
        <button type="button" className="xc-btn ghost" disabled={busy||shiireLoading} onClick={()=>void load()}>{busy||shiireLoading?"読み込み中…":"再読み込み"}</button>
      </div>

      <section className="xc-stat-grid">
        <article className="xc-stat cyan"><span>商品数</span><strong>{totals.products}</strong><small>両Botの合計</small></article>
        <article className="xc-stat teal"><span>総在庫数</span><strong>{totals.stock}</strong><small>即時納品可能</small></article>
        <article className={`xc-stat ${totals.empty?"red":"violet"}`}><span>在庫切れ</span><strong>{totals.empty+"品"}</strong><small>補充が必要</small></article>
        <article className="xc-stat gold"><span>残りわずか</span><strong>{totals.low}</strong><small>在庫{LOW_STOCK}件以下</small></article>
      </section>

      <section className="xc-card">
        <div className="xc-page-head" style={{marginBottom:14}}>
          <div className="xc-filter" role="group" aria-label="絞り込み">
            {([["all","すべて"],["empty","在庫切れ"],["low","残りわずか"],["infinite","常時販売"],["shiire","仕入れbot"]] as const).map(([id,label])=>(
              <button type="button" key={id} aria-pressed={filter===id} onClick={()=>setFilter(id)}>{label}</button>
            ))}
          </div>
          <input className="xc-input" style={{maxWidth:260}} value={query} onChange={event=>setQuery(event.target.value)} placeholder="商品名・自販機名で検索" aria-label="商品を検索" />
        </div>
        <div className="xc-table-wrap">
          <table className="xc-table">
            <thead><tr><th>商品</th><th>自販機</th><th>Bot</th><th>在庫</th><th>状態</th><th>販売数</th><th>操作</th></tr></thead>
            <tbody>
              {visible.map(row=>{
                const empty=!row.infinite&&row.stock===0;
                const low=!row.infinite&&row.stock>0&&row.stock<=LOW_STOCK;
                return (
                  <tr key={row.key}>
                    <td><span className="xc-name"><span className="emoji">{row.emoji||"📦"}</span>{row.productName}</span></td>
                    <td>{row.machineName}</td>
                    <td>{row.bot==="shiire"?<span className="xc-pill orange">別Bot · 仕入れbot</span>:<span className="xc-pill violet">Xaccount-Bot</span>}</td>
                    <td style={{minWidth:160}}>
                      {row.infinite?<span className="xc-pill violet">常時販売 (∞)</span>:(
                        <div style={{display:"grid",gap:5}}>
                          <strong>{row.stock} 件</strong>
                          <div className="xc-bar"><span className={empty?"zero":low?"low":""} style={{width:Math.max(4,row.stock/maxStock*100)+"%"}} /></div>
                        </div>
                      )}
                    </td>
                    <td>
                      {row.infinite?<span className="xc-pill violet">固定内容</span>
                        :empty?<span className="xc-pill red">{row.stockless?"在庫切れ（無在庫販売中）":"在庫切れ"}</span>
                        :low?<span className="xc-pill orange">残りわずか</span>
                        :<span className="xc-pill green">十分</span>}
                    </td>
                    <td>{row.sales}</td>
                    <td className="actions">
                      {row.bot==="shiire"
                        ?<button type="button" className="xc-btn tiny edit" onClick={()=>onEditShiire(row.machineId)}>仕入れbotで管理</button>
                        :<button type="button" className="xc-btn tiny stock" onClick={()=>onOpenProduct(row.machineId,row.productId)}>在庫を編集</button>}
                    </td>
                  </tr>
                );
              })}
              {visible.length===0&&<tr><td colSpan={7} className="xc-empty">{busy||shiireLoading?"読み込み中…":"該当する商品はありません。"}</td></tr>}
            </tbody>
          </table>
        </div>
        {shiireLoading&&<div style={{marginTop:10}}><Loading label="仕入れbot（別Bot）の在庫を読み込み中…" /></div>}
        {!shiireLoading&&shiireError&&<p className="muted" style={{marginTop:10,fontSize:12}}>仕入れbot（別Bot）の在庫は取得できませんでした: {shiireError}</p>}
      </section>
    </>
  );
}
