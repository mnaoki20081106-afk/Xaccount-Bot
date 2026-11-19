import { FormEvent, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { Icon, Loading, Modal, errorText } from "./console-ui";
import ShiireOperationsCenter from "./ShiireOperationsCenter";

type Channel={id:string;name:string;type?:string;botCanPost?:boolean};
type Role={id:string;name:string;position:number;isEveryone:boolean};

type Field={key:string;label:string;type:"text"|"url"|"secret"|"select"|"number";required?:boolean;placeholder?:string;help?:string;options?:Array<{value:string;label:string}>};
type Template={id:string;label:string;description:string;fields:Field[];conditionFields:Field[]};
type Supplier={id:string;name:string;template:string;templateLabel:string;config:Record<string,string>;configuredSecrets:string[];enabled:boolean};
type Item={
  id:string;name:string;supplierId:string;supplierName:string|null;template:string|null;templateLabel:string|null;
  condition:Record<string,string>;mainProductId:string|null;destinationLabel:string|null;
  minStock:number;targetStock:number;maxStock:number;maxBatch:number;budgetPercent:number;enabled:boolean;
  destinationAvailable:number|null;destinationMissing:boolean;waitingTransfer:number|null;
  lastJob:{status:string;requested:number;delivered:number;error:string|null;updatedAt:number}|null;
};
type Overview={templates:Template[];suppliers:Supplier[];items:Item[];restockTime:string;catalogError:string|null};
type Machine={id:string;name:string;products:Array<{id:string;name:string;available:number}>};

type ItemDraft={
  name:string;supplierId:string;condition:Record<string,string>;machineId:string;mainProductId:string;
  minStock:number;targetStock:number;maxStock:number;maxBatch:number;budgetPercent:number;enabled:boolean;
};
type SupplierDraft={id?:string;name:string;template:string;config:Record<string,string>;secrets:Record<string,string>};

const NEW_SUPPLIER="__new__";

function conditionLabel(item:Item,templates:Template[]){
  const template=templates.find(row=>row.id===item.template);
  return (template?.conditionFields??[]).map(field=>{
    const value=item.condition[field.key];
    return field.options?.find(option=>option.value===value)?.label??value;
  }).filter(Boolean).join(" / ")||"—";
}

function jobLabel(job:Item["lastJob"]){
  if(!job) return null;
  const labels:Record<string,string>={delivered:"補充完了",out_of_stock:"仕入れ先が在庫切れ",acquiring:"仕入れ中",acquired:"仕入れ済み・補充待ち",
    delivery_failed:"補充に失敗（自動で再試行）",acquisition_failed:"仕入れに失敗（自動で再試行）",processing_failed:"変換に失敗（自動で再試行）",failed:"失敗"};
  return labels[job.status]??job.status;
}

export default function ProcurementCenter({
  guildId, channels, roles, onNotice, onError
}:{
  guildId:string;
  channels:Channel[];
  roles:Role[];
  onNotice:(message:string)=>void;
  onError:(reason:unknown)=>void;
}){
  const base=`/api/guilds/${guildId}/shiire/procurement`;
  const [tab,setTab]=useState<"items"|"payments"|"history">("items");
  const [data,setData]=useState<Overview|null>(null);
  const [loadError,setLoadError]=useState<string|null>(null);
  const [machines,setMachines]=useState<Machine[]|null>(null);
  const [busy,setBusy]=useState(false);
  const [restockTime,setRestockTime]=useState("18:00");
  const [editing,setEditing]=useState<{id:string|null;draft:ItemDraft}|null>(null);
  const [supplierDraft,setSupplierDraft]=useState<SupplierDraft|null>(null);
  const [intake,setIntake]=useState<{supplierId:string;sku:string;text:string}|null>(null);

  async function load(){
    setLoadError(null);
    try{
      const next=await api<Overview>(base,{},30_000);
      setData(next);
      setRestockTime(next.restockTime);
    }catch(reason){ setLoadError(errorText(reason)); }
  }
  async function loadMachines(){
    try{ setMachines((await api<{machines:Machine[]}>(base+"/destinations",{},30_000)).machines); }
    catch(reason){ setMachines([]); onError(reason); }
  }
  useEffect(()=>{ void load(); },[guildId]);

  async function run(action:()=>Promise<void>,message?:string){
    setBusy(true);
    try{ await action(); if(message) onNotice(message); }
    catch(reason){ onError(reason); }
    finally{ setBusy(false); }
  }

  const templates=data?.templates??[];
  const suppliers=data?.suppliers??[];
  const templateById=(id:string|null|undefined)=>templates.find(row=>row.id===id)??null;
  const supplierById=(id:string)=>suppliers.find(row=>row.id===id)??null;
  const budgetUsed=(data?.items??[]).reduce((sum,item)=>sum+Number(item.budgetPercent||0),0);

  function openEditor(item:Item|null){
    void loadMachines();
    setSupplierDraft(null);
    if(item){
      setEditing({id:item.id,draft:{
        name:item.name,supplierId:item.supplierId,condition:{...item.condition},
        machineId:"",mainProductId:item.mainProductId??"",minStock:item.minStock,targetStock:item.targetStock,
        maxStock:item.maxStock,maxBatch:item.maxBatch,budgetPercent:item.budgetPercent,enabled:item.enabled
      }});
    }else{
      setEditing({id:null,draft:{name:"",supplierId:suppliers[0]?.id??NEW_SUPPLIER,condition:{},machineId:"",mainProductId:"",
        minStock:1,targetStock:5,maxStock:0,maxBatch:10,budgetPercent:0,enabled:false}});
      if(!suppliers.length) setSupplierDraft({name:"",template:templates[0]?.id??"custom_api",config:{},secrets:{}});
      // HSTORA can be registered only once; new suppliers default to another template then.
    }
  }

  // Pick the machine of the current destination once the catalog has loaded.
  useEffect(()=>{
    if(!editing||!machines||editing.draft.machineId||!editing.draft.mainProductId) return;
    const machine=machines.find(row=>row.products.some(product=>product.id===editing.draft.mainProductId));
    if(machine) setEditing({...editing,draft:{...editing.draft,machineId:machine.id}});
  },[machines,editing]);

  async function saveSupplier():Promise<string|null>{
    if(!supplierDraft) return null;
    const payload={name:supplierDraft.name,template:supplierDraft.template,config:supplierDraft.config,secrets:supplierDraft.secrets};
    const saved=supplierDraft.id
      ?await api<Supplier>(base+"/suppliers/"+supplierDraft.id,{method:"PATCH",body:JSON.stringify(payload)})
      :await api<Supplier>(base+"/suppliers",{method:"POST",body:JSON.stringify(payload)});
    return saved.id;
  }

  async function saveItem(event:FormEvent){
    event.preventDefault();
    if(!editing) return;
    await run(async()=>{
      let supplierId=editing.draft.supplierId;
      if(supplierId===NEW_SUPPLIER){
        const created=await saveSupplier();
        if(!created) throw new Error("仕入れ先を入力してください");
        supplierId=created;
      }
      const payload={
        name:editing.draft.name,supplierId,condition:editing.draft.condition,mainProductId:editing.draft.mainProductId,
        minStock:editing.draft.minStock,targetStock:editing.draft.targetStock,maxStock:editing.draft.maxStock,
        maxBatch:editing.draft.maxBatch,budgetPercent:editing.draft.budgetPercent,enabled:editing.draft.enabled
      };
      if(editing.id) await api(base+"/items/"+editing.id,{method:"PATCH",body:JSON.stringify(payload)},30_000);
      else await api(base+"/items",{method:"POST",body:JSON.stringify(payload)},30_000);
      setEditing(null);
      setSupplierDraft(null);
      await load();
    },editing.id?"仕入れ品を更新しました":"仕入れ品を追加しました");
  }

  async function saveSupplierOnly(event:FormEvent){
    event.preventDefault();
    await run(async()=>{ await saveSupplier(); setSupplierDraft(null); await load(); },"仕入れ先を保存しました");
  }

  const editingTemplate=editing
    ?editing.draft.supplierId===NEW_SUPPLIER?templateById(supplierDraft?.template):templateById(supplierById(editing.draft.supplierId)?.template)
    :null;
  const selectedMachine=useMemo(()=>machines?.find(row=>row.id===editing?.draft.machineId)??null,[machines,editing?.draft.machineId]);

  function supplierFields(draft:SupplierDraft,setDraft:(next:SupplierDraft)=>void,existing:Supplier|null){
    const template=templateById(draft.template);
    return (
      <>
        {!draft.id&&(
          <div className="xc-template-grid" role="radiogroup" aria-label="仕入れ先のテンプレート">
            {templates.filter(row=>row.id!=="hstora"||!suppliers.some(supplier=>supplier.template==="hstora")).map(row=>(
              <button type="button" key={row.id} role="radio" aria-checked={draft.template===row.id}
                className={`xc-template ${draft.template===row.id?"active":""}`}
                onClick={()=>setDraft({...draft,template:row.id,config:{},secrets:{}})}>
                <strong>{row.label}</strong><small>{row.description}</small>
              </button>
            ))}
          </div>
        )}
        <label>仕入れ先の名前
          <input value={draft.name} maxLength={80} required placeholder={template?.label??""} onChange={event=>setDraft({...draft,name:event.target.value})} />
        </label>
        {(template?.fields??[]).map(field=>{
          const configured=existing?.configuredSecrets.includes(field.key);
          return (
            <label key={field.key}>{field.label}{field.required&&!configured?"（必須）":""}
              <input
                type={field.type==="secret"?"password":field.type==="url"?"url":"text"}
                autoComplete="off"
                value={field.type==="secret"?(draft.secrets[field.key]??""):(draft.config[field.key]??"")}
                placeholder={field.type==="secret"&&configured?"設定済み（変更する場合のみ入力）":field.placeholder??""}
                required={Boolean(field.required&&!(field.type==="secret"&&configured))}
                onChange={event=>field.type==="secret"
                  ?setDraft({...draft,secrets:{...draft.secrets,[field.key]:event.target.value}})
                  :setDraft({...draft,config:{...draft.config,[field.key]:event.target.value}})}
              />
              {field.help&&<small className="muted">{field.help}</small>}
            </label>
          );
        })}
        {template?.fields.some(field=>field.type==="secret")&&(
          <small className="muted">APIキーは暗号化して保存され、保存後は画面に表示されません。</small>
        )}
      </>
    );
  }

  if(tab!=="items"){
    return (
      <>
        <ProcurementHeader tab={tab} setTab={setTab} />
        <ShiireOperationsCenter
          key={"ops:"+tab+":"+guildId}
          guildId={guildId}
          channels={channels}
          roles={roles}
          onNotice={onNotice}
          onError={onError}
          view={tab}
        />
      </>
    );
  }

  return (
    <>
      <ProcurementHeader tab={tab} setTab={setTab} />

      {loadError&&(
        <div className="alert error">仕入れbotに接続できませんでした: {loadError}
          <button type="button" className="xc-btn ghost tiny" style={{marginLeft:10}} onClick={()=>void load()}>再読み込み</button>
        </div>
      )}
      {!data&&!loadError&&<section className="xc-card"><Loading label="仕入れ品を読み込み中…（別Botのため少し時間がかかります）" /></section>}

      {data&&(
        <>
          {data.catalogError&&<div className="alert error">補充先（Xaccount-Botの商品）の在庫を取得できませんでした: {data.catalogError}</div>}
          <section className="xc-card">
            <div className="xc-page-head" style={{marginBottom:14}}>
              <div>
                <h2 style={{margin:0,fontSize:18}}>仕入れ品</h2>
                <p className="muted" style={{margin:"4px 0 0",fontSize:13}}>
                  毎日決まった時刻に、補充先の在庫が最低在庫を下回っていれば目標在庫まで仕入れて補充します。資金配分の合計: {budgetUsed}%
                </p>
              </div>
              <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                <label style={{display:"flex",gap:6,alignItems:"center",fontSize:13,fontWeight:800,color:"#9aa5c0"}}>毎日の仕入れ時刻
                  <input type="time" className="xc-input" style={{width:120}} value={restockTime} onChange={event=>setRestockTime(event.target.value)} />
                </label>
                <button type="button" className="xc-btn ghost tiny" disabled={busy||restockTime===data.restockTime}
                  onClick={()=>void run(async()=>{await api(base+"/restock-time",{method:"POST",body:JSON.stringify({restockTime})});await load();},"仕入れ時刻を保存しました")}>保存</button>
                <button type="button" className="xc-btn violet" onClick={()=>openEditor(null)}><Icon name="plus" size={15} /> 仕入れ品を追加</button>
              </div>
            </div>
            <div className="xc-table-wrap">
              <table className="xc-table">
                <thead><tr><th>仕入れ品</th><th>仕入れ先</th><th>補充先</th><th>在庫（現在 / 最低 / 目標）</th><th>資金配分</th><th>状態</th><th>操作</th></tr></thead>
                <tbody>
                  {data.items.map(item=>(
                    <tr key={item.id}>
                      <td>
                        <span className="xc-name">{item.name}</span>
                        <small className="muted" style={{display:"block",fontSize:12}}>{conditionLabel(item,templates)}</small>
                      </td>
                      <td>{item.supplierName??"—"}<small className="muted" style={{display:"block",fontSize:12}}>{item.templateLabel}</small></td>
                      <td>{item.destinationLabel
                        ?<>{item.destinationLabel}{item.destinationMissing&&<small style={{display:"block",color:"#ff7b86",fontSize:12}}>補充先の商品が見つかりません</small>}</>
                        :<span className="xc-pill orange">未設定</span>}</td>
                      <td>
                        <strong>{item.destinationAvailable??"—"}</strong> / {item.minStock} / {item.targetStock}
                        {item.maxStock>0&&<small className="muted"> （上限 {item.maxStock}）</small>}
                        {item.waitingTransfer?<small className="muted" style={{display:"block",fontSize:12}}>移動待ち {item.waitingTransfer}</small>:null}
                      </td>
                      <td>{item.budgetPercent}%</td>
                      <td>
                        {item.enabled?<span className="xc-pill green">有効</span>:<span className="xc-pill gray">停止中</span>}
                        {item.lastJob&&<small className="muted" style={{display:"block",fontSize:12}} title={item.lastJob.error??undefined}>{jobLabel(item.lastJob)}</small>}
                      </td>
                      <td className="actions">
                        {item.template==="manual"&&(
                          <button type="button" className="xc-btn tiny stock" onClick={()=>setIntake({supplierId:item.supplierId,sku:item.condition.sku??"",text:""})}>在庫を投入</button>
                        )}
                        <button type="button" className="xc-btn tiny stock" disabled={busy||!item.enabled}
                          onClick={()=>{ if(window.confirm(`「${item.name}」を今すぐ仕入れますか？（補充先の在庫が足りない分だけ仕入れます）`)) void run(async()=>{await api(base+"/items/"+item.id+"/run",{method:"POST",body:"{}"},120_000);await load();},"仕入れを実行しました。結果は状態と履歴で確認できます"); }}>今すぐ実行</button>
                        <button type="button" className="xc-btn tiny edit" onClick={()=>openEditor(item)}>編集</button>
                        <button type="button" className="xc-btn tiny del" disabled={busy}
                          onClick={()=>{ if(window.confirm(`仕入れ品「${item.name}」を削除しますか？補充先の商品と在庫はそのまま残ります。`)) void run(async()=>{await api(base+"/items/"+item.id,{method:"DELETE"});await load();},"仕入れ品を削除しました"); }}>削除</button>
                      </td>
                    </tr>
                  ))}
                  {data.items.length===0&&<tr><td colSpan={7} className="xc-empty">仕入れ品がありません。「仕入れ品を追加」から登録してください。</td></tr>}
                </tbody>
              </table>
            </div>
          </section>

          <details className="xc-card">
            <summary style={{cursor:"pointer",fontWeight:800}}>登録済みの仕入れ先（{suppliers.length}件）</summary>
            <p className="muted" style={{fontSize:13}}>仕入れ先は仕入れ品を追加するときにも作れます。ここではAPIキーの変更や削除ができます。</p>
            <div className="xc-asset-list">
              {suppliers.map(supplier=>(
                <div key={supplier.id} className="xc-asset-row">
                  <span style={{display:"grid",gap:2}}>
                    <strong>{supplier.name}</strong>
                    <small>{supplier.templateLabel}{supplier.configuredSecrets.length?" · APIキー設定済み":""}{supplier.enabled?"":" · 停止中"}</small>
                  </span>
                  <span style={{display:"flex",gap:6}}>
                    <button type="button" className="xc-btn tiny edit" onClick={()=>setSupplierDraft({id:supplier.id,name:supplier.name,template:supplier.template,config:{...supplier.config},secrets:{}})}>編集</button>
                    <button type="button" className="xc-btn tiny del" disabled={busy}
                      onClick={()=>{ if(window.confirm(`仕入れ先「${supplier.name}」を削除しますか？`)) void run(async()=>{await api(base+"/suppliers/"+supplier.id,{method:"DELETE"});await load();},"仕入れ先を削除しました"); }}>削除</button>
                  </span>
                </div>
              ))}
            </div>
          </details>
        </>
      )}

      {editing&&(
        <Modal title={editing.id?"仕入れ品を編集":"仕入れ品を追加"} onClose={()=>{setEditing(null);setSupplierDraft(null);}} wide>
          <form className="xc-form" onSubmit={event=>void saveItem(event)}>
            <label>仕入れ品の名前
              <input value={editing.draft.name} maxLength={80} required placeholder="例: 検索上位 Xアカウント" onChange={event=>setEditing({...editing,draft:{...editing.draft,name:event.target.value}})} />
            </label>

            <fieldset className="xc-fieldset">
              <legend>① 仕入れ先</legend>
              <label>仕入れ先
                <select value={editing.draft.supplierId} onChange={event=>{
                  const value=event.target.value;
                  setEditing({...editing,draft:{...editing.draft,supplierId:value,condition:{}}});
                  const firstTemplate=templates.find(row=>row.id!=="hstora"||!suppliers.some(supplier=>supplier.template==="hstora"))?.id??"custom_api";
                  setSupplierDraft(value===NEW_SUPPLIER?{name:"",template:firstTemplate,config:{},secrets:{}}:null);
                }}>
                  {suppliers.map(supplier=><option key={supplier.id} value={supplier.id}>{supplier.name}（{supplier.templateLabel}）</option>)}
                  <option value={NEW_SUPPLIER}>＋ 新しい仕入れ先を登録</option>
                </select>
              </label>
              {editing.draft.supplierId===NEW_SUPPLIER&&supplierDraft&&supplierFields(supplierDraft,setSupplierDraft,null)}
            </fieldset>

            <fieldset className="xc-fieldset">
              <legend>② 仕入れ条件</legend>
              {(editingTemplate?.conditionFields??[]).map(field=>(
                <label key={field.key}>{field.label}
                  {field.type==="select"
                    ?<select value={editing.draft.condition[field.key]??""} required={field.required}
                        onChange={event=>setEditing({...editing,draft:{...editing.draft,condition:{...editing.draft.condition,[field.key]:event.target.value}}})}>
                        <option value="">選択してください</option>
                        {(field.options??[]).map(option=><option key={option.value} value={option.value}>{option.label}</option>)}
                      </select>
                    :<input value={editing.draft.condition[field.key]??""} required={field.required} placeholder={field.placeholder??""}
                        onChange={event=>setEditing({...editing,draft:{...editing.draft,condition:{...editing.draft.condition,[field.key]:event.target.value}}})} />}
                  {field.help&&<small className="muted">{field.help}</small>}
                </label>
              ))}
              {!editingTemplate&&<small className="muted">仕入れ先を選ぶと条件の入力欄が出ます。</small>}
            </fieldset>

            <fieldset className="xc-fieldset">
              <legend>③ 補充先（Xaccount-Botの自販機と商品）</legend>
              {!machines&&<Loading label="自販機を読み込み中…" />}
              {machines&&(
                <div className="two">
                  <label>自販機
                    <select value={editing.draft.machineId} onChange={event=>setEditing({...editing,draft:{...editing.draft,machineId:event.target.value,mainProductId:""}})}>
                      <option value="">選択してください</option>
                      {machines.map(machine=><option key={machine.id} value={machine.id}>{machine.name}</option>)}
                    </select>
                  </label>
                  <label>商品
                    <select value={editing.draft.mainProductId} disabled={!selectedMachine} onChange={event=>setEditing({...editing,draft:{...editing.draft,mainProductId:event.target.value}})}>
                      <option value="">{selectedMachine?"選択してください":"先に自販機を選択"}</option>
                      {(selectedMachine?.products??[]).map(product=><option key={product.id} value={product.id}>{product.name}（在庫 {product.available}）</option>)}
                    </select>
                  </label>
                </div>
              )}
              {machines&&machines.length===0&&<small className="muted">在庫を補充できる商品がありません。「自販機 & 商品管理」で在庫納品の商品を作ってください（常時販売の商品は選べません）。</small>}
            </fieldset>

            <fieldset className="xc-fieldset">
              <legend>④ 在庫と資金</legend>
              <div className="two">
                <label>最低在庫（これを下回ったら仕入れ）<input type="number" min={0} value={editing.draft.minStock} onChange={event=>setEditing({...editing,draft:{...editing.draft,minStock:Number(event.target.value)}})} /></label>
                <label>目標在庫（ここまで仕入れる）<input type="number" min={1} value={editing.draft.targetStock} onChange={event=>setEditing({...editing,draft:{...editing.draft,targetStock:Number(event.target.value)}})} /></label>
                <label>在庫数の上限（0 = なし）<input type="number" min={0} value={editing.draft.maxStock} onChange={event=>setEditing({...editing,draft:{...editing.draft,maxStock:Number(event.target.value)}})} /></label>
                <label>1回の最大仕入れ数<input type="number" min={1} max={500} value={editing.draft.maxBatch} onChange={event=>setEditing({...editing,draft:{...editing.draft,maxBatch:Number(event.target.value)}})} /></label>
                <label>資金配分（%）<input type="number" min={0} max={100} step={1} value={editing.draft.budgetPercent} onChange={event=>setEditing({...editing,draft:{...editing.draft,budgetPercent:Number(event.target.value)}})} />
                  <small className="muted">共通ウォレットの資金のうち、この仕入れ品に割り当てる割合。全仕入れ品の合計は100%まで。</small>
                </label>
              </div>
            </fieldset>

            <label style={{display:"flex",alignItems:"center",gap:8}}>
              <input type="checkbox" style={{width:"auto"}} checked={editing.draft.enabled} onChange={event=>setEditing({...editing,draft:{...editing.draft,enabled:event.target.checked}})} />
              この仕入れ品を有効にする（補充先の商品を選ぶと有効にできます）
            </label>

            <div className="xc-form-footer">
              <button type="submit" className="xc-btn violet" disabled={busy}>{busy?"保存中…":"保存"}</button>
              <button type="button" className="xc-btn ghost" onClick={()=>{setEditing(null);setSupplierDraft(null);}}>キャンセル</button>
            </div>
          </form>
        </Modal>
      )}

      {supplierDraft?.id&&!editing&&(
        <Modal title="仕入れ先を編集" onClose={()=>setSupplierDraft(null)}>
          <form className="xc-form" onSubmit={event=>void saveSupplierOnly(event)}>
            {supplierFields(supplierDraft,setSupplierDraft,supplierById(supplierDraft.id))}
            <div className="xc-form-footer">
              <button type="submit" className="xc-btn violet" disabled={busy}>保存</button>
              <button type="button" className="xc-btn ghost" onClick={()=>setSupplierDraft(null)}>キャンセル</button>
            </div>
          </form>
        </Modal>
      )}

      {intake&&(
        <Modal title="在庫を投入（手動投入）" onClose={()=>setIntake(null)}>
          <form className="xc-form" onSubmit={event=>{event.preventDefault();void run(async()=>{
            const result=await api<{added?:number}>(base+"/suppliers/"+intake.supplierId+"/intake",{method:"POST",body:JSON.stringify({sku:intake.sku,text:intake.text})});
            setIntake(null);await load();
            onNotice(`在庫を${result.added??0}件投入しました。毎日の仕入れ時刻（または「今すぐ実行」）で補充先へ流れます`);
          });}}>
            <label>1行 = 1在庫（最大1000行）
              <textarea value={intake.text} required onChange={event=>setIntake({...intake,text:event.target.value})} />
            </label>
            <div className="xc-form-footer">
              <button type="submit" className="xc-btn violet" disabled={busy||!intake.text.trim()}>投入</button>
              <button type="button" className="xc-btn ghost" onClick={()=>setIntake(null)}>キャンセル</button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}

function ProcurementHeader({tab,setTab}:{tab:"items"|"payments"|"history";setTab:(tab:"items"|"payments"|"history")=>void}){
  return (
    <div className="xc-page-head">
      <div>
        <h1>仕入れ <span className="xc-pill orange" style={{verticalAlign:4}}>別Bot · Discord-Shiire</span></h1>
        <p>仕入れbotが仕入れ先から仕入れ、Xaccount-Botの自販機の商品へ補充します。販売・決済・納品はXaccount-Botが行います。</p>
      </div>
      <div className="xc-filter" role="group" aria-label="仕入れのメニュー">
        {([["items","仕入れ品"],["payments","支払い・ウォレット"],["history","履歴"]] as const).map(([id,label])=>(
          <button type="button" key={id} aria-pressed={tab===id} onClick={()=>setTab(id)}>{label}</button>
        ))}
      </div>
    </div>
  );
}
