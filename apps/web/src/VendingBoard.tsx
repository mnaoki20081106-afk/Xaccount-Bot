import { FormEvent, Fragment, useEffect, useState } from "react";
import { api } from "./api";
import {
  ConsoleChannel, DiscordText, Icon, Loading, Modal, ShiireMachineRow, VmDetail, VmMachine, VmPanelRow, VmProduct,
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
  guildId, channels, onOpenDetail, onEditShiire, onNotice, onError, focusProductId, onFocusHandled
}:{
  guildId:string;
  // From 在庫エディタ: open this product's 在庫管理 row once the list is loaded.
  focusProductId?:string|null;
  onFocusHandled?:()=>void;
  channels:ConsoleChannel[];
  onOpenDetail:(machineId:string,section?:"panel"|"settings"|"achievement")=>void;
  onEditShiire:(machineId:string)=>void;
  onNotice:(message:string)=>void;
  onError:(reason:unknown)=>void;
}){
  const [machines,setMachines]=useState<BoardMachine[]>([]);
  const [loaded,setLoaded]=useState(false);
  const [busy,setBusy]=useState(false);
  const [creating,setCreating]=useState(false);
  const [newName,setNewName]=useState("");
  const [addingTo,setAddingTo]=useState<string|null>(null);
  const [productForm,setProductForm]=useState(emptyProduct);
  const [channelEdit,setChannelEdit]=useState<{machineId:string;channelId:string}|null>(null);
  const [stockOpen,setStockOpen]=useState<string|null>(null);
  const [stockText,setStockText]=useState("");
  // Stock contents / withdrawal inside the 在庫管理 row.
  const [stockItems,setStockItems]=useState<{productId:string;title:string;lines:string[]}|null>(null);
  const [withdrawQty,setWithdrawQty]=useState(1);
  // 帯の色 popover, preview modal and product edit modal.
  const [colorEdit,setColorEdit]=useState<{machineId:string;value:string}|null>(null);
  const [previewId,setPreviewId]=useState<string|null>(null);
  const [productEdit,setProductEdit]=useState<{machineId:string;productId:string;form:typeof emptyProduct}|null>(null);

  const postable=postableChannels(channels);

  // Both bots load in parallel; the 仕入れbot (another worker) can take several seconds.
  async function loadOwn(){
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
  }
  async function load(){
    await loadOwn();
  }

  useEffect(()=>{ void load(); },[guildId]);

  useEffect(()=>{
    if(!focusProductId||!loaded) return;
    if(machines.some(machine=>machine.products.some(product=>product.id===focusProductId))){
      setStockOpen(focusProductId);
      setStockText("");
      setStockItems(null);
      requestAnimationFrame(()=>document.getElementById("stock-row-"+focusProductId)?.scrollIntoView({block:"center",behavior:"smooth"}));
    }
    onFocusHandled?.();
  },[focusProductId,loaded,machines]);

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
      await loadOwn();
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
      await loadOwn();
      if(result.previousRemoved===false){
        onError(new Error("新しいパネルは設置しましたが、旧パネルのメッセージを削除できませんでした。Discord側で削除してください"));
      }
    },machine.name+" のパネルを #"+(channelName(channels,channelId)??channelId)+" に設置しました");
  }

  async function removeMachine(machine:BoardMachine){
    if(!window.confirm(`自販機「${machine.name}」を削除しますか？商品・在庫も利用できなくなります。`)) return;
    await run(async()=>{
      await api(`/api/guilds/${guildId}/vending/${machine.id}`,{method:"DELETE"});
      await loadOwn();
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
      await loadOwn();
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
      await loadOwn();
    }
  }

  async function removeProduct(machine:BoardMachine,product:VmProduct){
    if(!window.confirm(`商品「${product.name}」を削除しますか？`)) return;
    await run(async()=>{
      await api(`/api/guilds/${guildId}/vending/${machine.id}/products/${product.id}`,{method:"DELETE"});
      await loadOwn();
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
      await loadOwn();
      onNotice(`${product.name} に在庫を${result.added}件追加しました`);
    });
  }

  async function saveColor(machine:BoardMachine,value:string){
    if(!/^#[0-9a-f]{6}$/i.test(value)){ onError(new Error("色は #RRGGBB の16進数で入力してください")); return; }
    await run(async()=>{
      // The server re-renders an installed panel when the color changes.
      await api(`/api/guilds/${guildId}/vending/${machine.id}`,{method:"PATCH",body:JSON.stringify({panelColor:value})});
      setMachines(current=>current.map(row=>row.id===machine.id?{...row,panel_color:value}:row));
      setColorEdit(null);
    },machine.name+" の帯の色を変更しました"+(machine.panel?.messageId?"（設置済みパネルにも反映）":""));
  }

  function openProductEdit(machine:BoardMachine,product:VmProduct){
    setProductEdit({machineId:machine.id,productId:product.id,form:{
      name:product.name,description:product.description,pricePayPay:product.price_paypay,priceKyash:product.price_kyash,
      emoji:product.emoji??"",infiniteStock:Boolean(product.infinite_stock),infiniteContent:product.infinite_content??""
    }});
  }

  async function saveProductEdit(event:FormEvent){
    event.preventDefault();
    if(!productEdit) return;
    const {machineId,productId,form}=productEdit;
    await run(async()=>{
      await api(`/api/guilds/${guildId}/vending/${machineId}/products/${productId}`,{
        method:"PATCH",
        body:JSON.stringify({
          name:form.name.trim(),description:form.description,
          pricePayPay:Number(form.pricePayPay),priceKyash:Number(form.priceKyash),
          emoji:form.emoji.trim()||null,infiniteStock:form.infiniteStock,
          infiniteContent:form.infiniteStock?form.infiniteContent:null
        })
      });
      setProductEdit(null);
      await loadOwn();
    },"商品を更新しました");
  }

  async function showStock(machine:BoardMachine,product:VmProduct){
    await run(async()=>{
      const items=await api<Array<{id:string;content:string}>>(`/api/guilds/${guildId}/vending/${machine.id}/products/${product.id}/stock`);
      setStockItems({productId:product.id,title:`${product.name} の在庫（${items.length}件${items.length>=500?"・先頭500件":""}）`,lines:items.map(item=>item.content)});
    });
  }

  async function withdrawStock(machine:BoardMachine,product:VmProduct){
    const quantity=Math.max(1,Math.min(500,Math.floor(withdrawQty)||1));
    if(!window.confirm(`${product.name} の在庫を${quantity}件引き出しますか？引き出した在庫は販売されなくなります。`)) return;
    await run(async()=>{
      const result=await api<{items:string[]}>(`/api/guilds/${guildId}/vending/${machine.id}/products/${product.id}/withdraw`,{
        method:"POST",body:JSON.stringify({quantity})
      });
      setStockItems({productId:product.id,title:`${product.name} から引き出した在庫（${result.items.length}件）`,lines:result.items});
      await loadOwn();
    },"在庫を引き出しました。内容をコピーして保管してください");
  }

  const previewMachine=machines.find(machine=>machine.id===previewId)??null;

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

      {!loaded&&<section className="xc-card"><Loading label="自販機を読み込み中…" /></section>}

      {loaded&&machines.length===0&&(
        <section className="xc-card xc-empty">まだXaccount-Botの自販機がありません。「新しい自販機を作成」から追加してください。</section>
      )}

      {machines.map(machine=>(
        <section key={machine.id} className="xc-card xc-machine" aria-label={machine.name}>
          <div className="xc-machine-head">
            <div className="xc-machine-title">
              <span className="xc-color-anchor">
                <button
                  type="button"
                  className="xc-color-dot"
                  style={{background:machine.panel_color||"#57f287"}}
                  aria-label={machine.name+"の帯の色を変更"}
                  title="帯の色を変更"
                  aria-expanded={colorEdit?.machineId===machine.id}
                  onClick={()=>setColorEdit(current=>current?.machineId===machine.id?null:{machineId:machine.id,value:machine.panel_color||"#57f287"})}
                />
                {colorEdit?.machineId===machine.id&&(
                  <div className="xc-color-popover" role="dialog" aria-label="帯の色">
                    <strong>帯の色</strong>
                    <div className="xc-color">
                      <input type="color" aria-label="カラーパレット" value={/^#[0-9a-f]{6}$/i.test(colorEdit.value)?colorEdit.value:"#57f287"} onChange={event=>setColorEdit({machineId:machine.id,value:event.target.value})} />
                      <input type="text" aria-label="16進数カラー" className="xc-input" value={colorEdit.value} maxLength={7}
                        onChange={event=>{const raw=event.target.value.trim();setColorEdit({machineId:machine.id,value:raw.startsWith("#")?raw:"#"+raw});}} />
                    </div>
                    <div className="xc-color-swatches">
                      {["#57f287","#5865f2","#3867d6","#eb459e","#fee75c","#ed4245","#f0a35b","#ffffff","#000000"].map(color=>(
                        <button type="button" key={color} style={{background:color}} aria-label={color} onClick={()=>setColorEdit({machineId:machine.id,value:color})} />
                      ))}
                    </div>
                    <div style={{display:"flex",gap:8}}>
                      <button type="button" className="xc-btn violet tiny" disabled={busy} onClick={()=>void saveColor(machine,colorEdit.value)}>保存</button>
                      <button type="button" className="xc-btn ghost tiny" onClick={()=>setColorEdit(null)}>キャンセル</button>
                    </div>
                  </div>
                )}
              </span>
              <h2>{machine.name}</h2>
              <span className="xc-pill id">{machine.id.slice(0,8)}</span>
              {machine.panel?.channelId
                ?<span className="xc-pill green">✅ パネル稼働中 (#{channelName(channels,machine.panel.channelId)})</span>
                :<span className="xc-pill gray">パネル未設置</span>}
            </div>
            <div className="xc-machine-actions">
              <button type="button" className="xc-btn ghost" onClick={()=>setPreviewId(machine.id)}>
                プレビューを表示
              </button>
              <button type="button" className="xc-btn green" disabled={busy} onClick={()=>void reinstallPanel(machine)}>
                <Icon name="refresh" size={15} /> パネル再設置
              </button>
              <button type="button" className="xc-btn ghost icon" title="詳細設定（パネル文面・画像・ログ・在庫通知・実績部屋）" aria-label={machine.name+"の詳細設定"} onClick={()=>onOpenDetail(machine.id,"panel")}>
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
                          <button type="button" className="xc-btn tiny stock" aria-expanded={stockOpen===product.id} onClick={()=>{setStockOpen(stockOpen===product.id?null:product.id);setStockText("");setStockItems(null);setWithdrawQty(1);}}>在庫管理</button>
                        )}
                        <button type="button" className="xc-btn tiny edit" onClick={()=>openProductEdit(machine,product)}>編集</button>
                        <button type="button" className="xc-btn tiny del" disabled={busy} onClick={()=>void removeProduct(machine,product)}>削除</button>
                      </td>
                    </tr>
                    {stockOpen===product.id&&(
                      <tr id={"stock-row-"+product.id}>
                        <td colSpan={8}>
                          <div className="xc-inline-form" style={{margin:0}}>
                            <label>{product.name} に在庫を追加（1行 = 1在庫、最大500行）
                              <textarea rows={5} value={stockText} onChange={event=>setStockText(event.target.value)} placeholder={"username:password:...\nusername:password:..."} />
                            </label>
                            <div className="row">
                              <button type="button" className="xc-btn violet" disabled={busy||!stockText.trim()} onClick={()=>void addStock(machine,product)}>
                                {stockText.trim()?`${stockText.split(/\r?\n/).filter(line=>line.trim()).length}件を追加`:"在庫を追加"}
                              </button>
                              <button type="button" className="xc-btn ghost" disabled={busy||product.stock_count===0} onClick={()=>void showStock(machine,product)}>中身を表示</button>
                              <label style={{flex:"0 0 auto",display:"flex",alignItems:"center",gap:6,flexDirection:"row"}}>
                                <input type="number" min={1} max={500} value={withdrawQty} style={{width:80}} aria-label="引き出す件数" onChange={event=>setWithdrawQty(Number(event.target.value))} />
                                件
                              </label>
                              <button type="button" className="xc-btn red" disabled={busy||product.stock_count===0} onClick={()=>void withdrawStock(machine,product)}>引き出す</button>
                              <span className="muted" style={{fontSize:12}}>現在の在庫: {product.stock_count} 件</span>
                            </div>
                            {stockItems?.productId===product.id&&(
                              <label>{stockItems.title}
                                <textarea rows={Math.min(10,Math.max(3,stockItems.lines.length))} readOnly value={stockItems.lines.join("\n")} onFocus={event=>event.currentTarget.select()} />
                              </label>
                            )}
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

      {previewMachine&&(
        <Modal title={previewMachine.name+" のプレビュー"} onClose={()=>setPreviewId(null)} wide>
          <div className="xc-discord-preview">
            <div className="xc-discord-author">
              <span className="xc-discord-avatar">Bot</span>
              <strong>Xaccount-Bot</strong>
              <span className="xc-app-tag">アプリ</span>
            </div>
            <div className="xc-discord-embed" style={{borderLeftColor:previewMachine.panel_color||"#57f287"}}>
              <h4>{previewMachine.panel_title||previewMachine.name||"自販機"}</h4>
              <div className="embed-body">
                <DiscordText text={
                  (previewMachine.panel_description||"購入したい商品を下のボタンから選択してください。")+
                  (previewMachine.products.length
                    ?"\n\n"+previewMachine.products.map(product=>
                        (product.emoji?product.emoji+" ":"")+"**"+product.name+"**\nPayPay: "+product.price_paypay+"円 / Kyash: "+product.price_kyash+
                        "円 / 在庫: "+(product.infinite_stock?"∞":product.stock_count)+" / 販売: "+product.sales_count
                      ).join("\n\n")
                    :"\n\n現在販売中の商品はありません。")
                } />
              </div>
              {previewMachine.panel_image_url&&<img className="embed-image" src={previewMachine.panel_image_url} alt="" />}
            </div>
            <div className="xc-discord-buttons">
              <span className="green">🛒 購入する</span>
              <span className="blurple">📦 在庫・販売数</span>
            </div>
          </div>
          <p className="muted" style={{fontSize:12,marginTop:12}}>Discordに送信される内容と同じ構成です。タイトル・説明・画像は⚙（詳細設定）で変更できます。</p>
        </Modal>
      )}

      {productEdit&&(
        <Modal title="商品を編集" onClose={()=>setProductEdit(null)}>
          <form className="xc-form" onSubmit={event=>void saveProductEdit(event)}>
            <div className="two">
              <label>商品名<input value={productEdit.form.name} maxLength={80} required onChange={event=>setProductEdit({...productEdit,form:{...productEdit.form,name:event.target.value}})} /></label>
              <label>絵文字<input value={productEdit.form.emoji} maxLength={64} placeholder="📦" onChange={event=>setProductEdit({...productEdit,form:{...productEdit.form,emoji:event.target.value}})} /></label>
            </div>
            <div className="two">
              <label>PayPay価格（円）<input type="number" min={0} value={productEdit.form.pricePayPay} onChange={event=>setProductEdit({...productEdit,form:{...productEdit.form,pricePayPay:Number(event.target.value)}})} /></label>
              <label>Kyash価格（円）<input type="number" min={0} value={productEdit.form.priceKyash} onChange={event=>setProductEdit({...productEdit,form:{...productEdit.form,priceKyash:Number(event.target.value)}})} /></label>
            </div>
            <label>説明<input value={productEdit.form.description} maxLength={500} onChange={event=>setProductEdit({...productEdit,form:{...productEdit.form,description:event.target.value}})} /></label>
            <label style={{display:"flex",alignItems:"center",gap:8}}>
              <input type="checkbox" style={{width:"auto"}} checked={productEdit.form.infiniteStock} onChange={event=>setProductEdit({...productEdit,form:{...productEdit.form,infiniteStock:event.target.checked}})} />
              常時販売（無限在庫・毎回同じ内容を納品）
            </label>
            {productEdit.form.infiniteStock&&(
              <label>納品内容<textarea style={{minHeight:120}} value={productEdit.form.infiniteContent} required onChange={event=>setProductEdit({...productEdit,form:{...productEdit.form,infiniteContent:event.target.value}})} /></label>
            )}
            <div className="xc-form-footer">
              <button type="submit" className="xc-btn violet" disabled={busy}>保存</button>
              <button type="button" className="xc-btn ghost" onClick={()=>setProductEdit(null)}>キャンセル</button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
