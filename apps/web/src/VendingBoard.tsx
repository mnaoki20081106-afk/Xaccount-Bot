import { FormEvent, Fragment, useEffect, useState } from "react";
import { api } from "./api";
import {
  ConsoleChannel, Icon, ShiireMachineRow, VmDetail, VmMachine, VmPanelRow, VmProduct,
  channelName, errorText, postableChannels, yen
} from "./console-ui";

type BoardMachine = VmDetail & { panel:VmPanelRow|null };

const emptyProduct={name:"",description:"",pricePayPay:0,priceKyash:0,emoji:"",infiniteStock:false,infiniteContent:""};

/**
 * Table view of every vending machine (Xaccount-Bot) plus the 仕入れbot
 * machines, which belong to a different bot and are shown read-only.
 * Detailed editing (panel designer, logs, notifications, achievement rooms)
 * stays in the existing VendingManager, opened through onOpenDetail.
 */
export default function VendingBoard({
  guildId, channels, onOpenDetail, onEditShiire, onNotice, onError
}:{
  guildId:string;
  channels:ConsoleChannel[];
  onOpenDetail:(machineId:string,section?:"panel"|"products"|"settings"|"achievement",productId?:string|null)=>void;
  onEditShiire:(machineId:string)=>void;
  onNotice:(message:string)=>void;
  onError:(reason:unknown)=>void;
}){
  const [machines,setMachines]=useState<BoardMachine[]>([]);
  const [loaded,setLoaded]=useState(false);
  const [busy,setBusy]=useState(false);
  const [shiire,setShiire]=useState<ShiireMachineRow[]|null>(null);
  const [shiireError,setShiireError]=useState<string|null>(null);
  const [creating,setCreating]=useState(false);
  const [newName,setNewName]=useState("");
  const [addingTo,setAddingTo]=useState<string|null>(null);
  const [productForm,setProductForm]=useState(emptyProduct);
  const [channelEdit,setChannelEdit]=useState<{machineId:string;channelId:string}|null>(null);
  const [stockOpen,setStockOpen]=useState<string|null>(null);
  const [stockText,setStockText]=useState("");

  const postable=postableChannels(channels);

  async function load(){
    setBusy(true);
    try{
      const [list,panels]=await Promise.all([
        api<VmMachine[]>(`/api/guilds/${guildId}/vending`),
        api<VmPanelRow[]>(`/api/guilds/${guildId}/vending/panels`)
      ]);
      const details=await Promise.all(list.map(machine=>api<VmDetail>(`/api/guilds/${guildId}/vending/${machine.id}`)));
      setMachines(details.map(detail=>({...detail,panel:panels.find(row=>row.id===detail.id)??null})));
      setLoaded(true);
    }catch(reason){ onError(reason); }
    finally{ setBusy(false); }
    try{
      setShiire(await api<ShiireMachineRow[]>(`/api/guilds/${guildId}/shiire/vending`));
      setShiireError(null);
    }catch(reason){
      setShiire(null);
      setShiireError(errorText(reason));
    }
  }

  useEffect(()=>{ void load(); },[guildId]);

  async function run(action:()=>Promise<void>,message?:string){
    setBusy(true);
    try{
      await action();
      if(message) onNotice(message);
    }catch(reason){ onError(reason); }
    finally{ setBusy(false); }
  }

  async function createMachine(event:FormEvent){
    event.preventDefault();
    const name=newName.trim();
    if(!name) return;
    await run(async()=>{
      await api(`/api/guilds/${guildId}/vending`,{method:"POST",body:JSON.stringify({name})});
      setNewName("");
      setCreating(false);
      await load();
    },"自販機「"+name+"」を作成しました");
  }

  async function reinstallPanel(machine:BoardMachine){
    const panel=machine.panel;
    if(!panel?.channelId||!panel.messageId){
      setChannelEdit({machineId:machine.id,channelId:postable.find(row=>row.botCanPost!==false)?.id??""});
      onNotice("まだ設置されていません。設置先チャンネルを選んでください");
      return;
    }
    await run(async()=>{
      await api(`/api/guilds/${guildId}/vending/${machine.id}/panel/update`,{
        method:"POST",
        body:JSON.stringify({messageUrl:`https://discord.com/channels/${guildId}/${panel.channelId}/${panel.messageId}`})
      });
    },machine.name+" のパネルを最新の商品・在庫で更新しました");
  }

  async function installPanel(machine:BoardMachine,channelId:string){
    if(!channelId) return;
    await run(async()=>{
      const result=await api<{previousRemoved:boolean|null}>(`/api/guilds/${guildId}/vending/${machine.id}/panel`,{
        method:"POST",
        body:JSON.stringify({channelId,replacePrevious:true})
      });
      setChannelEdit(null);
      await load();
      if(result.previousRemoved===false){
        onError(new Error("新しいパネルは設置しましたが、旧パネルのメッセージを削除できませんでした。Discord側で削除してください"));
      }
    },machine.name+" のパネルを #"+(channelName(channels,channelId)??channelId)+" に設置しました");
  }

  async function removeMachine(machine:BoardMachine){
    if(!window.confirm(`自販機「${machine.name}」を削除しますか？商品・在庫も利用できなくなります。`)) return;
    await run(async()=>{
      await api(`/api/guilds/${guildId}/vending/${machine.id}`,{method:"DELETE"});
      await load();
    },"自販機を削除しました");
  }

  async function addProduct(event:FormEvent,machine:BoardMachine){
    event.preventDefault();
    await run(async()=>{
      await api(`/api/guilds/${guildId}/vending/${machine.id}/products`,{
        method:"POST",
        body:JSON.stringify({
          name:productForm.name.trim(),
          description:productForm.description,
          pricePayPay:Number(productForm.pricePayPay),
          priceKyash:Number(productForm.priceKyash),
          emoji:productForm.emoji.trim()||null,
          infiniteStock:productForm.infiniteStock,
          infiniteContent:productForm.infiniteStock?productForm.infiniteContent:null
        })
      });
      setProductForm(emptyProduct);
      setAddingTo(null);
      await load();
    },"商品を追加しました");
  }

  async function moveProduct(machine:BoardMachine,index:number,delta:-1|1){
    const target=index+delta;
    if(target<0||target>=machine.products.length) return;
    const next=[...machine.products];
    [next[index],next[target]]=[next[target]!,next[index]!];
    // Optimistic reorder; the server rejects a stale list and we reload.
    setMachines(current=>current.map(row=>row.id===machine.id?{...row,products:next}:row));
    try{
      await api(`/api/guilds/${guildId}/vending/${machine.id}/products/reorder`,{
        method:"POST",
        body:JSON.stringify({productIds:next.map(product=>product.id)})
      });
    }catch(reason){
      onError(reason);
      await load();
    }
  }

  async function removeProduct(machine:BoardMachine,product:VmProduct){
    if(!window.confirm(`商品「${product.name}」を削除しますか？`)) return;
    await run(async()=>{
      await api(`/api/guilds/${guildId}/vending/${machine.id}/products/${product.id}`,{method:"DELETE"});
      await load();
    },"商品を削除しました");
  }

  async function addStock(machine:BoardMachine,product:VmProduct){
    const lines=stockText.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
    if(lines.length===0) return;
    await run(async()=>{
      const result=await api<{added:number}>(`/api/guilds/${guildId}/vending/${machine.id}/products/${product.id}/stock`,{
        method:"POST",
        body:JSON.stringify({lines})
      });
      setStockText("");
      await load();
      onNotice(`${product.name} に在庫を${result.added}件追加しました`);
    });
  }

  return (
    <>
      <div className="xc-page-head">
        <div>
          <h1>自販機 &amp; 商品管理</h1>
          <p>登録されている自販機とその商品の価格・説明・在庫を管理します。仕入れbot（別Bot）の自販機も下にまとめて表示します。</p>
        </div>
        <button type="button" className="xc-btn violet lg" onClick={()=>setCreating(value=>!value)}>
          <Icon name="plus" size={16} /> 新しい自販機を作成
        </button>
      </div>

      {creating&&(
        <form className="xc-inline-form" onSubmit={event=>void createMachine(event)}>
          <div className="row">
            <label>自販機名
              <input value={newName} maxLength={80} onChange={event=>setNewName(event.target.value)} placeholder="例: Xアカウント" required autoFocus />
            </label>
            <button className="xc-btn violet" type="submit" disabled={busy}>作成</button>
            <button className="xc-btn ghost" type="button" onClick={()=>setCreating(false)}>キャンセル</button>
          </div>
        </form>
      )}

      {loaded&&machines.length===0&&(
        <section className="xc-card xc-empty">まだXaccount-Botの自販機がありません。「新しい自販機を作成」から追加してください。</section>
      )}

      {machines.map(machine=>(
        <section key={machine.id} className="xc-card xc-machine" aria-label={machine.name}>
          <div className="xc-machine-head">
            <div className="xc-machine-title">
              <h2>{machine.name}</h2>
              <span className="xc-pill id">{machine.id.slice(0,8)}</span>
              {machine.panel?.channelId
                ?<span className="xc-pill green">✅ パネル稼働中 (#{channelName(channels,machine.panel.channelId)})</span>
                :<span className="xc-pill gray">パネル未設置</span>}
            </div>
            <div className="xc-machine-actions">
              <button type="button" className="xc-btn green" disabled={busy} onClick={()=>void reinstallPanel(machine)}>
                <Icon name="refresh" size={15} /> パネル再設置
              </button>
              <button type="button" className="xc-btn ghost icon" title="詳細設定（パネルデザイン・ログ・通知・実績部屋）" aria-label={machine.name+"の詳細設定"} onClick={()=>onOpenDetail(machine.id,"panel")}>
                <Icon name="gear" size={16} />
              </button>
              <button type="button" className="xc-btn blue" onClick={()=>setChannelEdit(current=>current?.machineId===machine.id?null:{
                machineId:machine.id,
                channelId:machine.panel?.channelId??postable.find(row=>row.botCanPost!==false)?.id??""
              })}>📍 チャンネル変更</button>
              <button type="button" className="xc-btn green" onClick={()=>{setAddingTo(addingTo===machine.id?null:machine.id);setProductForm(emptyProduct);}}>
                <Icon name="plus" size={15} /> 商品追加
              </button>
              <button type="button" className="xc-btn red" disabled={busy} onClick={()=>void removeMachine(machine)}>削除</button>
            </div>
          </div>

          {channelEdit?.machineId===machine.id&&(
            <div className="xc-inline-form">
              <div className="row">
                <label>設置先チャンネル
                  <select value={channelEdit.channelId} onChange={event=>setChannelEdit({machineId:machine.id,channelId:event.target.value})}>
                    <option value="">チャンネルを選択...</option>
                    {postable.map(channel=>(
                      <option key={channel.id} value={channel.id} disabled={channel.botCanPost===false}>
                        #{channel.name}{channel.botCanPost===false?" — BOTアクセス不可":""}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="button" className="xc-btn violet" disabled={busy||!channelEdit.channelId} onClick={()=>void installPanel(machine,channelEdit.channelId)}>このチャンネルに設置</button>
                <button type="button" className="xc-btn ghost" onClick={()=>setChannelEdit(null)}>閉じる</button>
              </div>
              {machine.panel?.channelId&&<small className="muted">設置後、旧チャンネル（#{channelName(channels,machine.panel.channelId)}）のパネルは自動で削除されます。</small>}
            </div>
          )}

          {addingTo===machine.id&&(
            <form className="xc-inline-form" onSubmit={event=>void addProduct(event,machine)}>
              <div className="row">
                <label>商品名<input value={productForm.name} maxLength={80} required onChange={event=>setProductForm({...productForm,name:event.target.value})} /></label>
                <label style={{flex:"0 1 110px"}}>絵文字<input value={productForm.emoji} maxLength={64} placeholder="📦" onChange={event=>setProductForm({...productForm,emoji:event.target.value})} /></label>
                <label style={{flex:"0 1 140px"}}>PayPay価格（円）<input type="number" min={0} value={productForm.pricePayPay} onChange={event=>setProductForm({...productForm,pricePayPay:Number(event.target.value)})} /></label>
                <label style={{flex:"0 1 140px"}}>Kyash価格（円）<input type="number" min={0} value={productForm.priceKyash} onChange={event=>setProductForm({...productForm,priceKyash:Number(event.target.value)})} /></label>
              </div>
              <label>説明<input value={productForm.description} maxLength={500} onChange={event=>setProductForm({...productForm,description:event.target.value})} /></label>
              <label style={{display:"flex",alignItems:"center",gap:8,fontWeight:700}}>
                <input type="checkbox" style={{width:"auto"}} checked={productForm.infiniteStock} onChange={event=>setProductForm({...productForm,infiniteStock:event.target.checked})} />
                常時販売（無限在庫・毎回同じ内容を納品）
              </label>
              {productForm.infiniteStock&&(
                <label>納品内容<textarea rows={3} value={productForm.infiniteContent} required onChange={event=>setProductForm({...productForm,infiniteContent:event.target.value})} /></label>
              )}
              <div className="row">
                <button type="submit" className="xc-btn violet" disabled={busy}>商品を追加</button>
                <button type="button" className="xc-btn ghost" onClick={()=>setAddingTo(null)}>キャンセル</button>
              </div>
            </form>
          )}

          <div className="xc-table-wrap">
            <table className="xc-table">
              <thead>
                <tr><th>順序</th><th>商品名</th><th>価格</th><th>発送タイプ</th><th>在庫数</th><th>販売数</th><th>説明</th><th>アクション</th></tr>
              </thead>
              <tbody>
                {machine.products.map((product,index)=>(
                  <Fragment key={product.id}>
                    <tr>
                      <td>
                        <div className="xc-order">
                          {index+1}
                          <span className="xc-order-arrows">
                            <button type="button" aria-label={product.name+"を上へ"} disabled={busy||index===0} onClick={()=>void moveProduct(machine,index,-1)}>▲</button>
                            <button type="button" aria-label={product.name+"を下へ"} disabled={busy||index===machine.products.length-1} onClick={()=>void moveProduct(machine,index,1)}>▼</button>
                          </span>
                        </div>
                      </td>
                      <td><span className="xc-name"><span className="emoji">{product.emoji||"📦"}</span>{product.name}</span></td>
                      <td className="price">
                        {yen(product.price_paypay)}
                        <small>{product.price_kyash===product.price_paypay?"PayPay / Kyash":`PayPay · Kyash ${yen(product.price_kyash)}`}</small>
                      </td>
                      <td>{product.infinite_stock
                        ?<span className="xc-pill orange">♾ 固定内容</span>
                        :<span className="xc-pill blue">📦 在庫納品</span>}</td>
                      <td>
                        <div className="xc-stock">
                          {product.infinite_stock
                            ?<span className="xc-pill violet">常時販売 (∞)</span>
                            :<span className={`xc-pill ${product.stock_count===0?"red":"green"}`}>在庫 {product.stock_count}</span>}
                        </div>
                      </td>
                      <td>{product.sales_count}</td>
                      <td className={product.description?"desc":"muted"}>{product.description||"-"}</td>
                      <td className="actions">
                        {!product.infinite_stock&&(
                          <button type="button" className="xc-btn tiny stock" aria-expanded={stockOpen===product.id} onClick={()=>{setStockOpen(stockOpen===product.id?null:product.id);setStockText("");}}>在庫管理</button>
                        )}
                        <button type="button" className="xc-btn tiny edit" onClick={()=>onOpenDetail(machine.id,"products",product.id)}>編集</button>
                        <button type="button" className="xc-btn tiny del" disabled={busy} onClick={()=>void removeProduct(machine,product)}>削除</button>
                      </td>
                    </tr>
                    {stockOpen===product.id&&(
                      <tr>
                        <td colSpan={8}>
                          <div className="xc-inline-form" style={{margin:0}}>
                            <label>{product.name} に在庫を追加（1行 = 1在庫、最大500行）
                              <textarea rows={5} value={stockText} onChange={event=>setStockText(event.target.value)} placeholder={"username:password:...\nusername:password:..."} />
                            </label>
                            <div className="row">
                              <button type="button" className="xc-btn violet" disabled={busy||!stockText.trim()} onClick={()=>void addStock(machine,product)}>
                                {stockText.trim()?`${stockText.split(/\r?\n/).filter(line=>line.trim()).length}件を追加`:"在庫を追加"}
                              </button>
                              <button type="button" className="xc-btn ghost" onClick={()=>onOpenDetail(machine.id,"products",product.id)}>在庫の中身確認・引き出し</button>
                              <span className="muted" style={{fontSize:12}}>現在の在庫: {product.stock_count} 件</span>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
                {machine.products.length===0&&(
                  <tr><td colSpan={8} className="xc-empty">商品がありません。「商品追加」から登録してください。</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      ))}

      <div className="xc-bot-banner" role="note">
        <span aria-hidden="true">🔗</span>
        <span>
          <strong>ここから下は別Bot「仕入れbot（Discord-Shiire）」の自販機です。</strong><br />
          Xアカウントの自動仕入れ在庫を販売・納品するのは仕入れbotです。価格・パネル・在庫の編集は「仕入れbot」画面で行います（決済受取はこの管理画面のPayPay/Kyash設定を共有）。
        </span>
      </div>

      {shiireError&&<section className="xc-card xc-empty">仕入れbotに接続できませんでした: {shiireError}</section>}
      {shiire&&shiire.length===0&&<section className="xc-card xc-empty">仕入れbotの自販機はまだありません。</section>}

      {(shiire??[]).map(machine=>{
        const products=machine.products??[];
        const panel=machine.panels?.[0]??null;
        return (
          <section key={machine.id} className="xc-card xc-machine other-bot" aria-label={machine.name+"（仕入れbot）"}>
            <div className="xc-machine-head">
              <div className="xc-machine-title">
                <h2>{machine.name}</h2>
                <span className="xc-pill orange">別Bot · 仕入れbot</span>
                {panel
                  ?<span className="xc-pill green">✅ パネル稼働中 (#{channelName(channels,panel.channel_id)})</span>
                  :<span className="xc-pill gray">パネル未設置</span>}
              </div>
              <div className="xc-machine-actions">
                <button type="button" className="xc-btn ghost" onClick={()=>onEditShiire(machine.id)}>仕入れbotで管理 →</button>
              </div>
            </div>
            <div className="xc-table-wrap">
              <table className="xc-table">
                <thead><tr><th>#</th><th>商品名</th><th>価格</th><th>発送タイプ</th><th>在庫数</th><th>販売数</th><th>説明</th><th>アクション</th></tr></thead>
                <tbody>
                  {products.map((product,index)=>(
                    <tr key={product.id}>
                      <td className="muted">{index+1}</td>
                      <td><span className="xc-name"><span className="emoji">{product.emoji||"📦"}</span>{product.name}</span></td>
                      <td className="price">{yen(product.price_paypay)}<small>{product.price_kyash===product.price_paypay?"PayPay / Kyash":`PayPay · Kyash ${yen(product.price_kyash)}`}</small></td>
                      <td>{product.stockless_enabled?<span className="xc-pill orange">⏳ 無在庫販売（注文後に仕入れ）</span>:<span className="xc-pill blue">🚚 自動仕入れ在庫</span>}</td>
                      <td><span className={`xc-pill ${product.stock_count===0?"red":"green"}`}>在庫 {product.stock_count}</span></td>
                      <td>{product.sales_count}</td>
                      <td className={product.description?"desc":"muted"}>{product.description||"-"}</td>
                      <td className="actions"><button type="button" className="xc-btn tiny edit" onClick={()=>onEditShiire(machine.id)}>仕入れbotで編集</button></td>
                    </tr>
                  ))}
                  {products.length===0&&<tr><td colSpan={8} className="xc-empty">商品がありません。</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </>
  );
}
