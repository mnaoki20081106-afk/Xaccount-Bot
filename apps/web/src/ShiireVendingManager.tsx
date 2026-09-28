import { useEffect, useMemo, useState } from "react";
import { api } from "./api";

type Channel={
  id:string;
  name:string;
  type?:string;
};
type Role={
  id:string;
  name:string;
  position:number;
  isEveryone:boolean;
};
type Status={
  configured:boolean;
  installed:boolean;
  guild:null|{id:string;name:string};
  discordError:string|null;
  payment:{paypay:boolean;kyash:boolean};
  inviteUrl:string|null;
};
type SourceProduct={
  supplier_product_id:string;
  title:string;
  currency:string;
  unit_price:number;
  stock_available:number;
  qualified:number;
  last_seen_at:number;
};
type Product={
  id:string;
  vending_machine_id:string;
  supplier_product_id:string;
  name:string;
  description:string;
  price_paypay:number;
  price_kyash:number;
  emoji:string|null;
  sales_count:number;
  stock_count:number;
};
type Notification={
  guild_id:string;
  channel_id:string;
  role_id:string;
  enabled:number;
}|null;
type Machine={
  id:string;
  guild_id:string;
  name:string;
  public_log_channel_id:string|null;
  private_log_channel_id:string|null;
  role_id:string|null;
  panel_title:string|null;
  panel_description:string|null;
  panel_image_url:string|null;
  active:number;
  products?:Product[];
  coupons?:Array<{code:string;discount:number;created_at:number}>;
  stockNotification?:Notification;
};
type Order={
  id:string;
  product_id:string;
  user_id:string;
  payment_method:string;
  quantity:number;
  total_amount:number;
  status:string;
  created_at:number;
  delivered_at:number|null;
};

async function prepareShiirePanelImage(file:File):Promise<string>{
  if(!file.type.startsWith("image/")) throw new Error("画像ファイルを選択してください");
  const objectUrl=URL.createObjectURL(file);
  try{
    const image=await new Promise<HTMLImageElement>((resolve,reject)=>{
      const element=new Image();
      element.onload=()=>resolve(element);
      element.onerror=()=>reject(new Error("画像を読み込めませんでした"));
      element.src=objectUrl;
    });
    let scale=Math.min(1,1600/Math.max(image.naturalWidth,image.naturalHeight));
    for(let attempt=0;attempt<5;attempt++){
      const canvas=document.createElement("canvas");
      canvas.width=Math.max(1,Math.round(image.naturalWidth*scale));
      canvas.height=Math.max(1,Math.round(image.naturalHeight*scale));
      const context=canvas.getContext("2d");
      if(!context) throw new Error("画像の圧縮処理を開始できません");
      context.drawImage(image,0,0,canvas.width,canvas.height);
      const quality=Math.max(.58,.88-attempt*.08);
      const dataUrl=canvas.toDataURL("image/webp",quality);
      if(dataUrl.length<=1_150_000) return dataUrl;
      scale*=.78;
    }
    throw new Error("画像を900KB以下まで圧縮できませんでした");
  }finally{
    URL.revokeObjectURL(objectUrl);
  }
}

function postableChannels(channels:Channel[]){
  return channels.filter(channel=>
    channel.type==="text"||channel.type==="announcement"||!channel.type
  );
}

export default function ShiireVendingManager({
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
  const [status,setStatus]=useState<Status|null>(null);
  const [machines,setMachines]=useState<Machine[]>([]);
  const [sources,setSources]=useState<SourceProduct[]>([]);
  const [orders,setOrders]=useState<Order[]>([]);
  const [selectedId,setSelectedId]=useState("");
  const [busy,setBusy]=useState(false);
  const [newMachineName,setNewMachineName]=useState("Xアカウント自販機");

  const [machineName,setMachineName]=useState("");
  const [panelTitle,setPanelTitle]=useState("");
  const [panelDescription,setPanelDescription]=useState("");
  const [panelImageUrl,setPanelImageUrl]=useState("");
  const [panelImageBusy,setPanelImageBusy]=useState(false);
  const [publicLogChannel,setPublicLogChannel]=useState("");
  const [privateLogChannel,setPrivateLogChannel]=useState("");
  const [buyerRole,setBuyerRole]=useState("");

  const [sourceId,setSourceId]=useState("");
  const [productName,setProductName]=useState("");
  const [productDescription,setProductDescription]=useState("");
  const [pricePayPay,setPricePayPay]=useState(100);
  const [priceKyash,setPriceKyash]=useState(100);
  const [emoji,setEmoji]=useState("");
  const [editingProductId,setEditingProductId]=useState("");

  const [notifyEnabled,setNotifyEnabled]=useState(false);
  const [notifyChannel,setNotifyChannel]=useState("");
  const [notifyRole,setNotifyRole]=useState("");

  const [panelChannel,setPanelChannel]=useState("");
  const [panelMessageUrl,setPanelMessageUrl]=useState("");

  const [couponCode,setCouponCode]=useState("");
  const [couponDiscount,setCouponDiscount]=useState(0);

  const selected=useMemo(
    ()=>machines.find(machine=>machine.id===selectedId)??null,
    [machines,selectedId]
  );
  const messageChannels=useMemo(()=>postableChannels(channels),[channels]);

  function applySelected(machine:Machine|null){
    setMachineName(machine?.name??"");
    setPanelTitle(machine?.panel_title??"");
    setPanelDescription(machine?.panel_description??"");
    setPanelImageUrl(machine?.panel_image_url??"");
    setPublicLogChannel(machine?.public_log_channel_id??"");
    setPrivateLogChannel(machine?.private_log_channel_id??"");
    setBuyerRole(machine?.role_id??"");
    setNotifyEnabled(Boolean(machine?.stockNotification?.enabled));
    setNotifyChannel(machine?.stockNotification?.channel_id??"");
    setNotifyRole(machine?.stockNotification?.role_id??"");
    setPanelChannel(current=>
      current||messageChannels[0]?.id||""
    );
  }

  async function load(){
    setBusy(true);
    try{
      const [nextStatus,nextMachines,nextSources,nextOrders]=await Promise.all([
        api<Status>(`/api/guilds/${guildId}/shiire/status`,{},15_000),
        api<Machine[]>(`/api/guilds/${guildId}/shiire/vending`,{},15_000),
        api<{products:SourceProduct[]}>(`/api/guilds/${guildId}/shiire/source-products`,{},15_000),
        api<{orders:Order[]}>(`/api/guilds/${guildId}/shiire/orders`,{},15_000)
      ]);
      setStatus(nextStatus);
      setMachines(nextMachines);
      setSources(nextSources.products??[]);
      setOrders(nextOrders.orders??[]);
      const nextId=
        nextMachines.some(machine=>machine.id===selectedId)
          ?selectedId
          :nextMachines[0]?.id??"";
      setSelectedId(nextId);
      const machine=nextMachines.find(row=>row.id===nextId)??null;
      applySelected(machine);
      if(!sourceId&&nextSources.products?.[0]){
        setSourceId(nextSources.products[0].supplier_product_id);
        setProductName(nextSources.products[0].title||"Xアカウント");
      }
    }catch(reason){
      onError(reason);
    }finally{
      setBusy(false);
    }
  }

  useEffect(()=>{void load()},[guildId]);

  useEffect(()=>{
    applySelected(selected);
  },[selectedId]);

  async function mutate(
    path:string,
    init:RequestInit,
    success:string
  ){
    setBusy(true);
    try{
      await api(path,init,20_000);
      onNotice(success);
      await load();
    }catch(reason){
      onError(reason);
    }finally{
      setBusy(false);
    }
  }

  async function createMachine(){
    const name=newMachineName.trim();
    if(!name) return onError(new Error("自販機名を入力してください"));
    await mutate(
      `/api/guilds/${guildId}/shiire/vending`,
      {method:"POST",body:JSON.stringify({name})},
      "仕入れBOT自販機を作成しました"
    );
  }

  async function saveMachine(){
    if(!selected) return;
    await mutate(
      `/api/guilds/${guildId}/shiire/vending/${selected.id}`,
      {
        method:"PATCH",
        body:JSON.stringify({
          name:machineName,
          panelTitle,
          panelDescription,
          publicLogChannelId:publicLogChannel||null,
          privateLogChannelId:privateLogChannel||null,
          roleId:buyerRole||null
        })
      },
      "自販機設定を保存しました"
    );
  }

  async function addProduct(){
    if(!selected) return;
    if(!sourceId) return onError(new Error("仕入れ商品を選択してください"));
    const payload={
      supplierProductId:sourceId,
      name:productName.trim()||"Xアカウント",
      description:productDescription,
      pricePayPay:Number(pricePayPay),
      priceKyash:Number(priceKyash),
      emoji:emoji.trim()||null
    };
    if(editingProductId){
      await mutate(
        `/api/guilds/${guildId}/shiire/vending/${selected.id}/products/${editingProductId}`,
        {method:"PATCH",body:JSON.stringify(payload)},
        "販売商品を更新しました"
      );
      setEditingProductId("");
      return;
    }
    await mutate(
      `/api/guilds/${guildId}/shiire/vending/${selected.id}/products`,
      {method:"POST",body:JSON.stringify(payload)},
      "仕入れ在庫を自販機商品へ紐付けました"
    );
  }

  function editProduct(product:Product){
    setEditingProductId(product.id);
    setSourceId(product.supplier_product_id);
    setProductName(product.name);
    setProductDescription(product.description);
    setPricePayPay(product.price_paypay);
    setPriceKyash(product.price_kyash);
    setEmoji(product.emoji??"");
  }

  function cancelProductEdit(){
    setEditingProductId("");
    setProductDescription("");
    setEmoji("");
  }

  async function deleteProduct(productId:string){
    if(!selected) return;
    if(!confirm("この販売商品を削除しますか？仕入れ済み在庫自体は削除されません。")) return;
    await mutate(
      `/api/guilds/${guildId}/shiire/vending/${selected.id}/products/${productId}`,
      {method:"DELETE"},
      "販売商品を削除しました"
    );
  }

  async function saveNotification(){
    if(!selected) return;
    await mutate(
      `/api/guilds/${guildId}/shiire/vending/${selected.id}/stock-notification`,
      {
        method:"POST",
        body:JSON.stringify({
          channelId:notifyChannel||null,
          roleId:notifyRole||null,
          enabled:notifyEnabled
        })
      },
      "在庫入荷通知を保存しました"
    );
  }

  async function uploadPanelImage(file:File){
    if(!selected) return;
    setPanelImageBusy(true);
    try{
      const dataUrl=await prepareShiirePanelImage(file);
      const result=await api<{url:string}>(
        `/api/guilds/${guildId}/shiire/vending/${selected.id}/panel-image`,
        {method:"POST",body:JSON.stringify({dataUrl})},
        30_000
      );
      setPanelImageUrl(result.url);
      onNotice("仕入れBOTパネル画像をアップロードしました");
      await load();
    }catch(reason){
      onError(reason);
    }finally{
      setPanelImageBusy(false);
    }
  }

  async function removePanelImage(){
    if(!selected||!panelImageUrl) return;
    setPanelImageBusy(true);
    try{
      await api(
        `/api/guilds/${guildId}/shiire/vending/${selected.id}/panel-image`,
        {method:"DELETE"}
      );
      setPanelImageUrl("");
      onNotice("仕入れBOTパネル画像を削除しました");
      await load();
    }catch(reason){
      onError(reason);
    }finally{
      setPanelImageBusy(false);
    }
  }

  async function publishPanel(){
    if(!selected||!panelChannel) return onError(new Error("設置先チャンネルを選択してください"));
    await mutate(
      `/api/guilds/${guildId}/shiire/vending/${selected.id}/panel`,
      {method:"POST",body:JSON.stringify({channelId:panelChannel})},
      "仕入れBOT自販機パネルを設置しました"
    );
  }

  async function updatePanel(){
    if(!selected||!panelMessageUrl.trim()){
      return onError(new Error("更新するDiscordメッセージURLを入力してください"));
    }
    await mutate(
      `/api/guilds/${guildId}/shiire/vending/${selected.id}/panel/update`,
      {method:"POST",body:JSON.stringify({messageUrl:panelMessageUrl.trim()})},
      "自販機パネルを更新しました"
    );
  }

  async function addCoupon(){
    if(!selected||!couponCode.trim()||couponDiscount<=0){
      return onError(new Error("クーポンコードと値引額を入力してください"));
    }
    await mutate(
      `/api/guilds/${guildId}/shiire/vending/${selected.id}/coupons`,
      {method:"POST",body:JSON.stringify({code:couponCode.trim(),discount:Number(couponDiscount)})},
      "クーポンを追加しました"
    );
    setCouponCode("");
    setCouponDiscount(0);
  }

  async function deleteCoupon(code:string){
    if(!selected) return;
    await mutate(
      `/api/guilds/${guildId}/shiire/vending/${selected.id}/coupons/${encodeURIComponent(code)}`,
      {method:"DELETE"},
      "クーポンを削除しました"
    );
  }

  return (
    <div className="vending-manager">
      <section className="card">
        <div className="section-head">
          <div>
            <span className="eyebrow">DISCORD-SHIIRE</span>
            <h2>仕入れbot 自販機</h2>
            <p>
              自動仕入れしたXアカウントを暗号化したまま販売在庫へ接続します。
              購入確定時だけ復号し、購入者DMへ納品します。
            </p>
          </div>
          <button className="secondary" onClick={()=>void load()} disabled={busy}>
            再読み込み
          </button>
        </div>

        <div className="metric-grid">
          <article className="metric card">
            <span>SHIIRE BOT</span>
            <strong>{status?.installed?"接続済み":"未導入"}</strong>
            <small>{status?.guild?.name??status?.discordError??"Discord-Shiire"}</small>
          </article>
          <article className="metric card">
            <span>PAYPAY</span>
            <strong>{status?.payment.paypay?"READY":"OFF"}</strong>
            <small>メインBOTの受取設定を共用</small>
          </article>
          <article className="metric card">
            <span>KYASH</span>
            <strong>{status?.payment.kyash?"READY":"OFF"}</strong>
            <small>メインBOTの受取設定を共用</small>
          </article>
          <article className="metric card">
            <span>販売待ち在庫</span>
            <strong>
              {machines.flatMap(machine=>machine.products??[])
                .reduce((sum,product)=>sum+Number(product.stock_count||0),0)}
            </strong>
            <small>READY_FOR_DELIVERY</small>
          </article>
        </div>

        {!status?.installed&&status?.inviteUrl&&(
          <div className="serverless-note">
            <strong>Discord-Shiire Botをこのサーバーへ追加してください</strong>
            <span>仕入れBOT自販機のパネル操作と購入者DM納品にはDiscord-Shiire本人の導入が必要です。</span>
            <a
              className="primary"
              href={status.inviteUrl+"&guild_id="+encodeURIComponent(guildId)+"&disable_guild_select=true"}
              target="_blank"
              rel="noreferrer"
            >
              仕入れBotを追加
            </a>
          </div>
        )}
      </section>

      <section className="two-col">
        <article className="card">
          <div className="section-head">
            <div>
              <span className="eyebrow">VENDING MACHINES</span>
              <h2>自販機</h2>
            </div>
          </div>
          <div className="form-grid">
            <label className="field">
              <span>新しい自販機名</span>
              <input value={newMachineName} onChange={e=>setNewMachineName(e.target.value)} />
            </label>
            <button className="primary" onClick={()=>void createMachine()} disabled={busy}>
              自販機を作成
            </button>
          </div>
          <div className="list-stack">
            {machines.map(machine=>(
              <button
                key={machine.id}
                type="button"
                className={machine.id===selectedId?"primary":"secondary"}
                onClick={()=>setSelectedId(machine.id)}
              >
                {machine.name}
              </button>
            ))}
            {!machines.length&&<p>まだ仕入れBOT自販機がありません。</p>}
          </div>
        </article>

        <article className="card">
          <span className="eyebrow">SOURCE INVENTORY</span>
          <h2>仕入れ元商品</h2>
          <p>HStoraから取得・判定済みの商品を、販売商品へ紐付けます。</p>
          <div className="list-stack">
            {sources.slice(0,30).map(source=>(
              <div className="serverless-note" key={source.supplier_product_id}>
                <strong>{source.title||("#"+source.supplier_product_id)}</strong>
                <span>
                  ID {source.supplier_product_id} / {source.currency} {source.unit_price} /
                  HStora表示在庫 {source.stock_available} / {source.qualified?"Qualified":"未承認"}
                </span>
              </div>
            ))}
            {!sources.length&&<p>まだHStora商品が同期されていません。</p>}
          </div>
        </article>
      </section>

      {selected&&(
        <>
          <section className="card">
            <div className="section-head">
              <div>
                <span className="eyebrow">MACHINE SETTINGS</span>
                <h2>{selected.name}</h2>
              </div>
              <button className="primary" onClick={()=>void saveMachine()} disabled={busy}>
                自販機設定を保存
              </button>
            </div>

            <div className="form-grid two">
              <label className="field">
                <span>自販機名</span>
                <input value={machineName} onChange={e=>setMachineName(e.target.value)} />
              </label>
              <label className="field">
                <span>購入後ロール</span>
                <select value={buyerRole} onChange={e=>setBuyerRole(e.target.value)}>
                  <option value="">付与しない</option>
                  {roles.filter(role=>!role.isEveryone).map(role=>(
                    <option value={role.id} key={role.id}>{role.name}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>パネルタイトル</span>
                <input value={panelTitle} onChange={e=>setPanelTitle(e.target.value)} />
              </label>
              <label className="field">
                <span>公開ログ</span>
                <select value={publicLogChannel} onChange={e=>setPublicLogChannel(e.target.value)}>
                  <option value="">送信しない</option>
                  {messageChannels.map(channel=>(
                    <option value={channel.id} key={channel.id}>#{channel.name}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>非公開ログ</span>
                <select value={privateLogChannel} onChange={e=>setPrivateLogChannel(e.target.value)}>
                  <option value="">送信しない</option>
                  {messageChannels.map(channel=>(
                    <option value={channel.id} key={channel.id}>#{channel.name}</option>
                  ))}
                </select>
              </label>
            </div>
            <label className="field">
              <span>パネル説明</span>
              <textarea
                value={panelDescription}
                onChange={e=>setPanelDescription(e.target.value)}
                rows={4}
              />
            </label>
            <div className="field">
              <span>パネル画像</span>
              {panelImageUrl&&(
                <img
                  src={panelImageUrl}
                  alt="仕入れBOT自販機パネル"
                  style={{maxWidth:"100%",maxHeight:260,borderRadius:12,objectFit:"contain"}}
                />
              )}
              <input
                type="file"
                accept="image/*"
                disabled={panelImageBusy}
                onChange={event=>{
                  const file=event.target.files?.[0];
                  if(file) void uploadPanelImage(file);
                  event.currentTarget.value="";
                }}
              />
              {panelImageUrl&&(
                <button
                  type="button"
                  className="danger"
                  disabled={panelImageBusy}
                  onClick={()=>void removePanelImage()}
                >
                  パネル画像を削除
                </button>
              )}
            </div>
          </section>

          <section className="two-col">
            <article className="card">
              <span className="eyebrow">PRODUCTS</span>
              <h2>販売商品</h2>
              <div className="form-grid two">
                <label className="field">
                  <span>仕入れ商品</span>
                  <select
                    value={sourceId}
                    onChange={e=>{
                      const id=e.target.value;
                      setSourceId(id);
                      const source=sources.find(row=>row.supplier_product_id===id);
                      if(source) setProductName(source.title||"Xアカウント");
                    }}
                  >
                    <option value="">選択してください</option>
                    {sources.map(source=>(
                      <option key={source.supplier_product_id} value={source.supplier_product_id}>
                        {source.title||source.supplier_product_id}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>販売名</span>
                  <input value={productName} onChange={e=>setProductName(e.target.value)} />
                </label>
                <label className="field">
                  <span>PayPay価格</span>
                  <input type="number" min="0" value={pricePayPay} onChange={e=>setPricePayPay(Number(e.target.value))} />
                  <small>0円にするとPayPay販売を無効化します。</small>
                </label>
                <label className="field">
                  <span>Kyash価格</span>
                  <input type="number" min="0" value={priceKyash} onChange={e=>setPriceKyash(Number(e.target.value))} />
                  <small>0円にするとKyash販売を無効化します。</small>
                </label>
                <label className="field">
                  <span>絵文字</span>
                  <input value={emoji} onChange={e=>setEmoji(e.target.value)} placeholder="🐔" />
                </label>
              </div>
              <label className="field">
                <span>商品説明</span>
                <textarea value={productDescription} onChange={e=>setProductDescription(e.target.value)} rows={3} />
              </label>
              <div className="button-row">
                <button className="primary" onClick={()=>void addProduct()} disabled={busy||!sourceId}>
                  {editingProductId?"商品変更を保存":"販売商品へ追加"}
                </button>
                {editingProductId&&(
                  <button className="secondary" type="button" onClick={cancelProductEdit} disabled={busy}>
                    編集をキャンセル
                  </button>
                )}
              </div>

              <div className="list-stack">
                {(selected.products??[]).map(product=>(
                  <div className="serverless-note" key={product.id}>
                    <strong>{product.emoji} {product.name}</strong>
                    <span>
                      在庫 {product.stock_count} / 販売 {product.sales_count} /
                      PayPay {product.price_paypay}円 / Kyash {product.price_kyash}円
                    </span>
                    <div className="button-row">
                      <button className="secondary" onClick={()=>editProduct(product)} disabled={busy}>
                        商品を編集
                      </button>
                      <button className="danger" onClick={()=>void deleteProduct(product.id)} disabled={busy}>
                        商品を削除
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </article>

            <article className="card">
              <span className="eyebrow">STOCK NOTIFICATION</span>
              <h2>在庫入荷通知</h2>
              <p>HStoraから新しいXアカウントが仕入れられた時だけ通知します。</p>
              <label className="toggle-row">
                <span className="toggle-copy">
                  <strong>在庫入荷通知</strong>
                  <small>デフォルトOFF。通知先とメンションロールを設定して有効化します。</small>
                </span>
                <span className={`switch ${notifyEnabled?"on":""}`}>
                  <input type="checkbox" checked={notifyEnabled} onChange={e=>setNotifyEnabled(e.target.checked)} />
                  <span />
                </span>
              </label>
              <div className="form-grid">
                <label className="field">
                  <span>通知チャンネル</span>
                  <select value={notifyChannel} onChange={e=>setNotifyChannel(e.target.value)}>
                    <option value="">選択してください</option>
                    {messageChannels.map(channel=>(
                      <option value={channel.id} key={channel.id}>#{channel.name}</option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>メンションロール</span>
                  <select value={notifyRole} onChange={e=>setNotifyRole(e.target.value)}>
                    <option value="">選択してください</option>
                    {roles.filter(role=>!role.isEveryone).map(role=>(
                      <option value={role.id} key={role.id}>{role.name}</option>
                    ))}
                  </select>
                </label>
              </div>
              <button className="primary" onClick={()=>void saveNotification()} disabled={busy}>
                通知設定を保存
              </button>
            </article>
          </section>

          <section className="two-col">
            <article className="card">
              <span className="eyebrow">PANEL</span>
              <h2>自販機パネル</h2>
              <label className="field">
                <span>設置チャンネル</span>
                <select value={panelChannel} onChange={e=>setPanelChannel(e.target.value)}>
                  <option value="">選択してください</option>
                  {messageChannels.map(channel=>(
                    <option value={channel.id} key={channel.id}>#{channel.name}</option>
                  ))}
                </select>
              </label>
              <button className="primary" onClick={()=>void publishPanel()} disabled={busy||!panelChannel}>
                パネルを設置
              </button>
              <label className="field">
                <span>既存パネルのDiscordメッセージURL</span>
                <input
                  value={panelMessageUrl}
                  onChange={e=>setPanelMessageUrl(e.target.value)}
                  placeholder="https://discord.com/channels/..."
                />
              </label>
              <button className="secondary" onClick={()=>void updatePanel()} disabled={busy||!panelMessageUrl}>
                既存パネルを更新
              </button>
            </article>

            <article className="card">
              <span className="eyebrow">COUPONS</span>
              <h2>クーポン</h2>
              <div className="form-grid two">
                <label className="field">
                  <span>コード</span>
                  <input value={couponCode} onChange={e=>setCouponCode(e.target.value)} />
                </label>
                <label className="field">
                  <span>1個あたり値引額</span>
                  <input type="number" min="1" value={couponDiscount} onChange={e=>setCouponDiscount(Number(e.target.value))} />
                </label>
              </div>
              <button className="primary" onClick={()=>void addCoupon()} disabled={busy}>
                クーポン追加
              </button>
              <div className="list-stack">
                {(selected.coupons??[]).map(coupon=>(
                  <div className="serverless-note" key={coupon.code}>
                    <strong>{coupon.code}</strong>
                    <span>{coupon.discount}円引き</span>
                    <button className="danger" onClick={()=>void deleteCoupon(coupon.code)} disabled={busy}>
                      削除
                    </button>
                  </div>
                ))}
              </div>
            </article>
          </section>
        </>
      )}

      <section className="card">
        <span className="eyebrow">ORDERS</span>
        <h2>仕入れBOT自販機 注文履歴</h2>
        <div className="list-stack">
          {orders.slice(0,50).map(order=>(
            <div className="serverless-note" key={order.id}>
              <strong>{order.status} / {order.quantity}個 / {order.total_amount}円</strong>
              <span>
                {order.payment_method.toUpperCase()} / 購入者 {order.user_id} /
                {new Date(order.created_at).toLocaleString("ja-JP")}
              </span>
            </div>
          ))}
          {!orders.length&&<p>まだ注文はありません。</p>}
        </div>
      </section>
    </div>
  );
}
