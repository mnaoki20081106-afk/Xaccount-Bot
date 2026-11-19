import { FormEvent, useEffect, useState } from "react";
import { api } from "./api";
import { Loading, ShiireMachineRow, VmDetail, VmMachine, errorText, yen } from "./console-ui";

type Bot = "xaccount"|"shiire";
type CouponRow = { bot:Bot; machineId:string; machineName:string; code:string; discount:number; created_at:number };
type ShiireWithCoupons = ShiireMachineRow & { coupons?:Array<{code:string;discount:number;created_at:number}> };

function couponBase(guildId:string,bot:Bot,machineId:string){
  return bot==="shiire"
    ?`/api/guilds/${guildId}/shiire/vending/${machineId}/coupons`
    :`/api/guilds/${guildId}/vending/${machineId}/coupons`;
}

/** Coupons of every vending machine (Xaccount-Bot and the separate 仕入れbot) on one screen. */
export default function CouponCenter({
  guildId, onNotice, onError
}:{
  guildId:string;
  onNotice:(message:string)=>void;
  onError:(reason:unknown)=>void;
}){
  const [machines,setMachines]=useState<VmMachine[]>([]);
  const [shiireMachines,setShiireMachines]=useState<ShiireWithCoupons[]>([]);
  const [shiireError,setShiireError]=useState<string|null>(null);
  const [coupons,setCoupons]=useState<CouponRow[]>([]);
  const [busy,setBusy]=useState(false);
  // target = "xaccount:<id>" or "shiire:<id>"
  const [form,setForm]=useState({target:"",code:"",discount:100});

  async function load(){
    setBusy(true);
    const rows:CouponRow[]=[];
    let list:VmMachine[]=[];
    let shiire:ShiireWithCoupons[]=[];
    // Both bots in parallel; the 仕入れbot is a separate, slower worker.
    await Promise.all([
      (async()=>{
        try{
          list=await api<VmMachine[]>(`/api/guilds/${guildId}/vending`);
          const details=await Promise.all(list.map(machine=>api<VmDetail>(`/api/guilds/${guildId}/vending/${machine.id}`)));
          rows.push(...details.flatMap(detail=>detail.coupons.map(coupon=>({...coupon,bot:"xaccount" as const,machineId:detail.id,machineName:detail.name}))));
        }catch(reason){ onError(reason); }
      })(),
      // 仕入れbotの自販機は廃止済み（Xaccount-Botの自販機に一本化）。
    ]);
    rows.push(...shiire.flatMap(machine=>(machine.coupons??[]).map(coupon=>({...coupon,bot:"shiire" as const,machineId:machine.id,machineName:machine.name}))));
    setMachines(list);
    setShiireMachines(shiire);
    setCoupons(rows);
    const targets=[...list.map(machine=>"xaccount:"+machine.id),...shiire.map(machine=>"shiire:"+machine.id)];
    setForm(current=>({...current,target:targets.includes(current.target)?current.target:targets[0]??""}));
    setBusy(false);
  }

  useEffect(()=>{ void load(); },[guildId]);

  async function create(event:FormEvent){
    event.preventDefault();
    const [bot,machineId]=form.target.split(":") as [Bot,string];
    if(!machineId) return;
    setBusy(true);
    try{
      await api(couponBase(guildId,bot,machineId),{
        method:"POST",
        body:JSON.stringify({code:form.code.trim(),discount:Number(form.discount)})
      });
      onNotice("クーポン「"+form.code.trim()+"」を作成しました");
      setForm(current=>({...current,code:""}));
      await load();
    }catch(reason){ onError(reason); }
    finally{ setBusy(false); }
  }

  async function remove(row:CouponRow){
    if(!window.confirm(`クーポン「${row.code}」を無効化しますか？`)) return;
    setBusy(true);
    try{
      await api(couponBase(guildId,row.bot,row.machineId)+"/"+encodeURIComponent(row.code),{method:"DELETE"});
      onNotice("クーポンを無効化しました");
      await load();
    }catch(reason){ onError(reason); }
    finally{ setBusy(false); }
  }

  return (
    <>
      <div className="xc-page-head">
        <div>
          <h1>クーポン管理</h1>
          <p>自販機ごとの割引クーポンを作成・無効化します。仕入れbot（別Bot）の自販機のクーポンもここで一緒に管理できます。</p>
        </div>
      </div>

      <section className="xc-card">
        <form className="xc-inline-form" onSubmit={event=>void create(event)} style={{marginBottom:18}}>
          <div className="row">
            <label>自販機
              <select value={form.target} onChange={event=>setForm({...form,target:event.target.value})} required>
                {machines.length+shiireMachines.length===0&&<option value="">自販機がありません</option>}
                {machines.length>0&&(
                  <optgroup label="Xaccount-Bot">
                    {machines.map(machine=><option key={machine.id} value={"xaccount:"+machine.id}>{machine.name}</option>)}
                  </optgroup>
                )}
                {shiireMachines.length>0&&(
                  <optgroup label="別Bot · 仕入れbot">
                    {shiireMachines.map(machine=><option key={machine.id} value={"shiire:"+machine.id}>{machine.name}（仕入れbot）</option>)}
                  </optgroup>
                )}
              </select>
            </label>
            <label>クーポンコード
              <input value={form.code} maxLength={50} required onChange={event=>setForm({...form,code:event.target.value})} placeholder="例: WELCOME100" />
            </label>
            <label style={{flex:"0 1 170px"}}>割引額（円）
              <input type="number" min={1} step={1} value={form.discount} required onChange={event=>setForm({...form,discount:Number(event.target.value)})} />
            </label>
            <button type="submit" className="xc-btn violet" disabled={busy||!form.target}>クーポンを作成</button>
          </div>
        </form>

        <div className="xc-table-wrap">
          <table className="xc-table">
            <thead><tr><th>コード</th><th>自販機</th><th>Bot</th><th>割引額</th><th>作成日時</th><th>操作</th></tr></thead>
            <tbody>
              {coupons.map(row=>(
                <tr key={row.bot+":"+row.machineId+":"+row.code}>
                  <td><code>{row.code}</code></td>
                  <td>{row.machineName}</td>
                  <td>{row.bot==="shiire"?<span className="xc-pill orange">別Bot · 仕入れbot</span>:<span className="xc-pill violet">Xaccount-Bot</span>}</td>
                  <td className="price">{yen(row.discount)} 引き</td>
                  <td className="muted">{new Date(row.created_at).toLocaleString("ja-JP")}</td>
                  <td className="actions"><button type="button" className="xc-btn tiny del" disabled={busy} onClick={()=>void remove(row)}>無効化</button></td>
                </tr>
              ))}
              {coupons.length===0&&<tr><td colSpan={6} className={busy?"":"xc-empty"}>{busy?<Loading label="クーポンを読み込み中…（仕入れbotの分も取得しています）" />:"有効なクーポンはありません。"}</td></tr>}
            </tbody>
          </table>
        </div>
        {shiireError&&<p className="muted" style={{fontSize:12,marginTop:12}}>仕入れbot（別Bot）のクーポンは取得できませんでした: {shiireError}</p>}
      </section>
    </>
  );
}
