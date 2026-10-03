import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { DEFAULT_PANEL_COLOR, isPanelColor, PANEL_FORMAT_VERSION } from "./shiire-panel-payload";
import { api } from "./api";
const ShiirePanelPreview=lazy(()=>import("./ShiirePanelPreview"));

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
  panelFormat?:string;
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
  procurement_class:"TOP_SEARCH"|"NO_SHADOWBAN"|null;
  qualified:number;
  last_seen_at:number;
};
type Product={
  id:string;
  vending_machine_id:string;
  supplier_product_id:string;
  procurement_class:"TOP_SEARCH"|"NO_SHADOWBAN"|null;
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
  panel_color?:number|null;
  active:number;
  products?:Product[];
  panels?:Array<{
    channel_id:string;
    message_id:string;
    created_at:number;
    updated_at:number;
  }>;
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

const CLASS_SALES_PRESETS={
  "class:NO_SHADOWBAN":{
    name:"Search Top + No shadow ban",
    description:"検索上位に載るシャドバンされてない垢です。",
    price:350
  },
  "class:TOP_SEARCH":{
    name:"【old】Search Top + No shadow ban",
    description:"検索上位にのるシャドバンされていないOld垢です。より運用向きです！",
    price:500
  }
} as const;

function classSalesPreset(id:string){
  return CLASS_SALES_PRESETS[id as keyof typeof CLASS_SALES_PRESETS]??null;
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
  const [panelColor,setPanelColor]=useState(DEFAULT_PANEL_COLOR);
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
  const [productDrafts,setProductDrafts]=useState<Record<string,Product>>({});

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
    setPanelColor(isPanelColor(machine?.panel_color)?machine.panel_color:DEFAULT_PANEL_COLOR);
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

  async function load(preferredId=selectedId){
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
      setProductDrafts({});
      setSources(nextSources.products??[]);
      setOrders(nextOrders.orders??[]);
      const nextId=
        nextMachines.some(machine=>machine.id===preferredId)
          ?preferredId
          :nextMachines[0]?.id??"";
      setSelectedId(nextId);
      const machine=nextMachines.find(row=>row.id===nextId)??null;
      applySelected(machine);
      if(!sourceId){
        const preset=CLASS_SALES_PRESETS["class:NO_SHADOWBAN"];
        setSourceId("class:NO_SHADOWBAN");
        setProductName(preset.name);
        setProductDescription(preset.description);
        setPricePayPay(preset.price);
        setPriceKyash(preset.price);
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
    setBusy(true);
    try{
      const created=await api<Machine>(`/api/guilds/${guildId}/shiire/vending`,{method:"POST",body:JSON.stringify({name})},20_000);
      setEditingProductId("");
      await load(created.id);
      onNotice("2種類の商品を備えた自販機を作成しました");
    }catch(reason){onError(reason);}finally{setBusy(false);}
  }

  async function deleteMachine(){
    if(!selected) return;
    if(!confirm(`自販機「${selected.name}」とDiscord上の設置パネルを削除しますか？仕入れ在庫と購入履歴は保持します。`)) return;
    setBusy(true);
    try{
      const result=await api<{ok:boolean;panelErrors?:unknown[]}>(`/api/guilds/${guildId}/shiire/vending/${selected.id}`,{method:"DELETE"},25_000);
      setEditingProductId("");
      await load();
      onNotice(result.panelErrors?.length
        ?"自販機を削除しました。一部のDiscordパネルを撤去できなかったため、残ったパネルは手動で削除してください。販売は停止しています。"
        :"自販機と設置パネルを削除しました");
    }catch(reason){onError(reason);}finally{setBusy(false);}
  }

  function machineDraft(){
    return {name:machineName.trim(),panelTitle,panelDescription,panelColor,publicLogChannelId:publicLogChannel||null,privateLogChannelId:privateLogChannel||null,roleId:buyerRole||null};
  }

  function currentProductDraft():Product|null{
    const product=selected?.products?.find(row=>row.id===editingProductId);
    return product?{...product,name:productName,description:productDescription.slice(0,500),price_paypay:pricePayPay,price_kyash:priceKyash,emoji:emoji.trim().slice(0,64)||null,
      procurement_class:sourceId==="class:TOP_SEARCH"?"TOP_SEARCH":sourceId==="class:NO_SHADOWBAN"?"NO_SHADOWBAN":null,supplier_product_id:sourceId.startsWith("class:")?"":sourceId}:null;
  }
  const currentDraft=currentProductDraft();
  const previewProducts=(selected?.products??[]).map(product=>product.id===editingProductId&&currentDraft?currentDraft:productDrafts[product.id]??product);

  function productPayload(product:Product){
    return {name:product.name.trim()||"Xアカウント",description:product.description,pricePayPay:product.price_paypay,priceKyash:product.price_kyash,emoji:product.emoji||null,
      ...(product.procurement_class?{procurementClass:product.procurement_class}:{supplierProductId:product.supplier_product_id})};
  }

  async function persistPanelDraft(){
    if(!selected) return;
    const drafts={...productDrafts,...(currentDraft?{[currentDraft.id]:currentDraft}:{})};
    if(!isPanelColor(selected.panel_color)&&panelColor!==DEFAULT_PANEL_COLOR) throw new Error("色の変更には仕入れbotの最新版への更新・再起動が必要です");
    if(!isPanelColor(panelColor)) throw new Error("パネルの色を選び直してください");
    if(!machineName.trim()||machineName.trim().length>80) throw new Error("自販機名は1〜80文字で入力してください");
    for(const product of Object.values(drafts)){
      if(!Number.isSafeInteger(product.price_paypay)||product.price_paypay<0||!Number.isSafeInteger(product.price_kyash)||product.price_kyash<0) throw new Error("価格は0以上の整数で入力してください");
      if(product.name.trim().length>80) throw new Error("商品名は80文字以内で入力してください");
    }
    const base={name:selected.name,panelTitle:selected.panel_title??"",panelDescription:selected.panel_description??"",panelColor:isPanelColor(selected.panel_color)?selected.panel_color:DEFAULT_PANEL_COLOR,
      publicLogChannelId:selected.public_log_channel_id||null,privateLogChannelId:selected.private_log_channel_id||null,roleId:selected.role_id||null};
    const patch=Object.fromEntries(Object.entries(machineDraft()).filter(([key,value])=>value!==base[key as keyof typeof base]));
    const products=Object.values(drafts).filter(product=>{
      const original=selected.products?.find(row=>row.id===product.id);
      return !original||JSON.stringify(productPayload(product))!==JSON.stringify(productPayload(original));
    });
    const path=`/api/guilds/${guildId}/shiire/vending/${selected.id}`;
    // An empty patch explicitly refreshes existing panels when no settings changed.
    // Product-only edits must not revalidate unrelated channels or roles.
    if(Object.keys(patch).length||!products.length){
      await api(path,{method:"PATCH",body:JSON.stringify(patch)},20_000);
      const columns:Record<string,string>={name:"name",panelTitle:"panel_title",panelDescription:"panel_description",panelColor:"panel_color",publicLogChannelId:"public_log_channel_id",privateLogChannelId:"private_log_channel_id",roleId:"role_id"};
      const saved=Object.fromEntries(Object.entries(patch).map(([key,value])=>[columns[key],value]));
      setMachines(rows=>rows.map(row=>row.id===selected.id?{...row,...saved}:row));
    }
    for(const product of products){
      await api(`${path}/products/${product.id}`,{method:"PATCH",body:JSON.stringify(productPayload(product))},20_000);
      // Retain confirmed saves as the retry baseline if a later request fails.
      setMachines(rows=>rows.map(row=>row.id===selected.id?{...row,products:row.products?.map(original=>original.id===product.id?{...product,name:product.name.trim()||"Xアカウント"}:original)}:row));
    }
  }

  async function savePanelPreview(){
    if(!selected) return;
    setBusy(true);
    let saved=false;
    try{
      await persistPanelDraft();
      saved=true;
      // Saving vending edits does not depend on supplier/order/status endpoints.
      const nextMachines=await api<Machine[]>(`/api/guilds/${guildId}/shiire/vending`,{},15_000);
      const machine=nextMachines.find(row=>row.id===selected.id);
      if(!machine) throw new Error("保存した自販機を取得できませんでした");
      setMachines(nextMachines);
      applySelected(machine);
      setProductDrafts({});
      setEditingProductId("");
      onNotice("プレビューの変更を保存し、既設パネルへ反映しました");
    }catch(reason){
      const detail=reason instanceof Error?reason.message:String(reason);
      onError(new Error(saved
        ?`変更は保存済みですが、表示の更新に失敗しました。編集内容は残しています。再読み込みしてください。詳細: ${detail}`
        :`保存の応答を確認できませんでした。編集内容は残しています。「変更を保存して反映」で再試行してください。詳細: ${detail}`));
    }finally{setBusy(false);}
  }


  async function addProduct(repostPanels=false){
    if(!selected) return;
    if(!sourceId) return onError(new Error("仕入れ商品を選択してください"));
    const procurementClass=
      sourceId==="class:TOP_SEARCH"
        ?"TOP_SEARCH"
        :sourceId==="class:NO_SHADOWBAN"
          ?"NO_SHADOWBAN"
          :null;
    const payload={
      ...(procurementClass
        ?{procurementClass}
        :{supplierProductId:sourceId}),
      name:productName.trim()||"Xアカウント",
      description:productDescription,
      pricePayPay:Number(pricePayPay),
      priceKyash:Number(priceKyash),
      emoji:emoji.trim()||null,
      ...(editingProductId&&repostPanels?{repostPanels:true}:{})
    };
    if(editingProductId){
      setBusy(true);
      try{
        await persistPanelDraft();
        if(repostPanels) await api(`/api/guilds/${guildId}/shiire/vending/${selected.id}/panel/repost`,{method:"POST",body:"{}"},20_000);
        setEditingProductId("");
        await load();
        onNotice(repostPanels?"変更を保存し、自販機を再設置しました":"販売商品とパネルの変更を保存しました");
      }catch(reason){onError(reason);}finally{setBusy(false);}
      return;
    }
    await mutate(
      `/api/guilds/${guildId}/shiire/vending/${selected.id}/products`,
      {method:"POST",body:JSON.stringify(payload)},
      "仕入れ在庫を自販機商品へ紐付けました"
    );
  }

  function editProduct(product:Product){
    if(currentDraft&&currentDraft.id!==product.id) setProductDrafts(rows=>({...rows,[currentDraft.id]:currentDraft}));
    product=productDrafts[product.id]??product;
    setEditingProductId(product.id);
    setSourceId(
      product.procurement_class
        ?"class:"+product.procurement_class
        :product.supplier_product_id
    );
    setProductName(product.name);
    setProductDescription(product.description);
    setPricePayPay(product.price_paypay);
    setPriceKyash(product.price_kyash);
    setEmoji(product.emoji??"");
  }

  function cancelProductEdit(){
    setProductDrafts(rows=>{const next={...rows};delete next[editingProductId];return next;});
    setEditingProductId("");
    setProductDescription("");
    setEmoji("");
  }

  async function repostPanels(){
    if(!selected) return;
    if(!(selected.panels?.length??0)){
      return onError(new Error("再設置できる既存の自販機パネルがありません"));
    }
    if(!confirm("既設の自販機パネルを新しいメッセージとして再設置しますか？")) return;
    setBusy(true);
    try{await persistPanelDraft();}catch(reason){onError(reason);setBusy(false);return;}
    await mutate(
      `/api/guilds/${guildId}/shiire/vending/${selected.id}/panel/repost`,
      {method:"POST",body:"{}"},
      "既設の自販機パネルを新しい内容で再設置しました"
    );
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
      setMachines(rows=>rows.map(row=>row.id===selected.id?{...row,panel_image_url:result.url}:row));
      onNotice("仕入れBOTパネル画像をアップロードしました");
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
      setMachines(rows=>rows.map(row=>row.id===selected.id?{...row,panel_image_url:null}:row));
      onNotice("仕入れBOTパネル画像を削除しました");
    }catch(reason){
      onError(reason);
    }finally{
      setPanelImageBusy(false);
    }
  }

  async function publishPanel(){
    if(!selected||!panelChannel) return onError(new Error("設置先チャンネルを選択してください"));
    setBusy(true);
    try{await persistPanelDraft();}catch(reason){onError(reason);setBusy(false);return;}
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
    setBusy(true);
    try{await persistPanelDraft();}catch(reason){onError(reason);setBusy(false);return;}
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
    <fieldset className="vending-manager" disabled={busy||panelImageBusy} aria-label="自販機の編集" style={{border:0,minWidth:0}}>
      {status&&status.panelFormat!==PANEL_FORMAT_VERSION&&<div className="shiire-callout warn" role="status">
        <strong>Discord側のパネル表示が未更新です</strong>
        <span>Bot Factoryで仕入れbotを最新版へ更新・再起動してください。その後「変更を保存して反映」で更新できます。パネルの再設置だけではbotのコードは更新されません。</span>
      </div>}
      <section className="card">
        <div className="section-head">
          <div>
            <h2>販売設定</h2>
            <p>販売所を選び、価格と案内文を編集してDiscordへ設置します。保存した変更は設置済みの販売画面にも反映されます。</p>
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
            <strong>{status?.payment.paypay?"利用可能":"未設定"}</strong>
            <small>メインBOTの受取設定を共用</small>
          </article>
          <article className="metric card">
            <span>KYASH</span>
            <strong>{status?.payment.kyash?"利用可能":"未設定"}</strong>
            <small>メインBOTの受取設定を共用</small>
          </article>
          <article className="metric card">
            <span>販売待ち在庫</span>
            <strong>
              {machines.flatMap(machine=>machine.products??[])
                .reduce((sum,product)=>sum+Number(product.stock_count||0),0)}
            </strong>
            <small>購入後に納品できる在庫</small>
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

      <section className="card">
        <h2>1. 編集する販売所を選ぶ</h2>
        <label className="field"><span>販売所</span><select value={selectedId} disabled={busy} onChange={event=>{setEditingProductId("");setProductDrafts({});setSelectedId(event.target.value);}}><option value="">選択してください</option>{machines.map(machine=><option key={machine.id} value={machine.id}>{machine.name}</option>)}</select></label>
        <details className="shiire-disclosure" open={!machines.length}><summary>販売所を追加・削除</summary>
          <div className="form-grid"><label className="field"><span>新しい自販機名</span><input value={newMachineName} onChange={e=>setNewMachineName(e.target.value)} /></label><button className="primary" onClick={()=>void createMachine()} disabled={busy}>自販機を作成</button></div>
          {selected&&<button className="danger" disabled={busy} onClick={()=>void deleteMachine()}>選択中の自販機を削除</button>}
          {!machines.length&&<p>まず販売所を1つ作成してください。</p>}
        </details>
        <details className="shiire-disclosure"><summary>仕入れ元の詳しい情報</summary><p>仕入れの予算・在庫目標は「仕入れ設定」で変更できます。</p><div className="list-stack">{sources.slice(0,30).map(source=><div className="serverless-note" key={source.supplier_product_id}><strong>{source.title||("#"+source.supplier_product_id)}</strong><span>{source.procurement_class??"未分類"} / ID {source.supplier_product_id} / {source.currency} {source.unit_price} / 在庫 {source.stock_available} / {source.qualified?"購入条件を満たす":"未承認"}</span></div>)}{!sources.length&&<p>まだ仕入れ元の商品が同期されていません。</p>}</div></details>
      </section>

      {selected&&(
        <>
          <section className="card">
            <div className="section-head">
              <div>
                <h2>2. 価格と案内文を編集</h2><p>{selected.name} — 下の販売画面で商品を選ぶと価格を変更できます。</p>
              </div>

            </div>

            <label className="field shiire-panel-color"><span>パネルの色</span>
              <input type="color" aria-label="パネルの色" value={"#"+panelColor.toString(16).padStart(6,"0")} disabled={busy||panelImageBusy||!isPanelColor(selected.panel_color)} onChange={event=>setPanelColor(Number.parseInt(event.target.value.slice(1),16))} />
              {!isPanelColor(selected.panel_color)&&<small role="status">色の変更には仕入れbotの最新版への更新・再起動が必要です。</small>}
              <small>Discordのパネル左端の色です。選ぶとプレビューに反映されます。「変更を保存して反映」で設置済みのパネルも更新します。</small>
            </label>
            <Suspense fallback={<p>パネルプレビューを読み込み中…</p>}><ShiirePanelPreview key={selected.id} disabled={busy||panelImageBusy}
              machine={{...selected,name:machineName.trim(),panel_title:panelTitle,panel_description:panelDescription,panel_color:panelColor,panel_image_url:panelImageUrl||null}}
              products={previewProducts}
              editingProductId={editingProductId} onProductChange={patch=>{
                if(patch.name!==undefined)setProductName(patch.name);
                if(patch.description!==undefined)setProductDescription(patch.description);
                if(patch.price_paypay!==undefined)setPricePayPay(patch.price_paypay);
                if(patch.price_kyash!==undefined)setPriceKyash(patch.price_kyash);
              }}
              onTitle={setPanelTitle} onDescription={setPanelDescription}
              onProduct={id=>{const product=selected.products?.find(row=>row.id===id);if(product) editProduct(product);}} /></Suspense>
            <div className="button-row"><button className="primary" disabled={busy||panelImageBusy} onClick={()=>void savePanelPreview()}>変更を保存して反映</button></div>

            <details className="shiire-disclosure"><summary>案内文・画像・購入後の設定</summary>
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
                <input maxLength={256} value={panelTitle} onChange={e=>setPanelTitle(e.target.value)} />
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
                maxLength={3000}
                onChange={e=>setPanelDescription(e.target.value)}
                rows={4}
              />
            </label>
            <div className="field">
              <span>パネル画像</span>
              <small>画像を設定すると、上のパネル本文の下に表示されます。画像の変更・削除は保存直後にDiscordへ反映されます。</small>
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
            </details>
          </section>

          <section className="two-col">
            <details className="card shiire-disclosure"><summary>商品を追加・詳しい情報を編集</summary>
              <h2>販売商品</h2>
              <p>通常商品とOld商品をそれぞれ設定します。仕入れ元の商品IDが変わっても、対応する種類の在庫から自動納品します。</p>
              <div className="list-stack">
                {(selected.products??[]).map(product=>(
                  <div className="serverless-note" key={product.id}>
                    <strong>{product.emoji} {product.name}</strong>
                    <span>
                      {product.procurement_class
                        ?(({NO_SHADOWBAN:"シャドウバンなし",TOP_SEARCH:"検索上位",INVITE_CAMPAIGN:"招待特典用"} as Record<string,string>)[product.procurement_class]??product.procurement_class)+" / "
                        :"個別商品 / "}
                      在庫 {product.stock_count} / 販売 {product.sales_count} /
                      PayPay {product.price_paypay}円 / Kyash {product.price_kyash}円
                    </span>
                    <div className="button-row">
                      <button className="secondary" aria-label={product.name+"を編集"} onClick={()=>editProduct(product)} disabled={busy}>
                        商品を編集
                      </button>
                      <details className="shiire-disclosure"><summary>削除</summary><button className="danger" onClick={()=>void deleteProduct(product.id)} disabled={busy}>商品を削除</button></details>
                    </div>
                  </div>
                ))}
              </div>
              <details className="shiire-disclosure" open={Boolean(editingProductId)}><summary>{editingProductId?"選択した商品の編集":"商品を追加（詳細設定）"}</summary>

              <div className="form-grid two">
                <label className="field">
                  <span>仕入れ商品</span>
                  <select
                    value={sourceId}
                    onChange={e=>{
                      const id=e.target.value;
                      setSourceId(id);
                      const preset=classSalesPreset(id);
                      if(preset){
                        setProductName(preset.name);
                        setProductDescription(preset.description);
                        setPricePayPay(preset.price);
                        setPriceKyash(preset.price);
                        return;
                      }
                      const source=sources.find(row=>row.supplier_product_id===id);
                      if(source) setProductName(source.title||"Xアカウント");
                    }}
                  >
                    <option value="">選択してください</option>
                    <optgroup label="自動仕入れ在庫クラス">
                      <option value="class:NO_SHADOWBAN">
                        シャドウバンなし — 通常商品 / 350円
                      </option>
                      <option value="class:TOP_SEARCH">
                        検索上位 — Old商品 / 500円
                      </option>
                    </optgroup>
                    <optgroup label="個別HStora商品（上級設定）">
                      {sources.map(source=>(
                        <option key={source.supplier_product_id} value={source.supplier_product_id}>
                          [{source.procurement_class??"未分類"}] {source.title||source.supplier_product_id}
                        </option>
                      ))}
                    </optgroup>
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
                {!editingProductId&&<button className="primary" onClick={()=>void addProduct(false)} disabled={busy||!sourceId}>販売商品へ追加</button>}
                {editingProductId&&<p>価格・商品内容は、上の「変更を保存して反映」で案内文とまとめて保存できます。</p>}
                {editingProductId&&(
                  <>
                    <button className="secondary" type="button" onClick={cancelProductEdit} disabled={busy}>
                      編集をキャンセル
                    </button>
                  </>
                )}
              </div>

              </details>
            </details>

            <details className="card shiire-disclosure"><summary>入荷通知を設定する</summary>
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
            </details>
          </section>

          <section className="two-col">
            <article className="card">
              <h2>3. Discordへの設置</h2><p>新しいチャンネルへ設置するときに使います。設置後は「変更を保存して反映」だけで内容を更新できます。</p>
              <label className="field">
                <span>設置チャンネル</span>
                <select value={panelChannel} onChange={e=>setPanelChannel(e.target.value)}>
                  <option value="">選択してください</option>
                  {messageChannels.map(channel=>(
                    <option value={channel.id} key={channel.id}>#{channel.name}</option>
                  ))}
                </select>
              </label>
              <div className="button-row">
                <button className="primary" onClick={()=>void publishPanel()} disabled={busy||!panelChannel}>
                  パネルを設置
                </button>
              </div>
              <details className="shiire-disclosure"><summary>設置済みメッセージの修復</summary><p>表示が更新されない場合に使います。再設置すると旧メッセージが削除され、新しいメッセージに置き換わります。</p>
                <button
                  className="secondary"
                  onClick={()=>void repostPanels()}
                  disabled={busy||!(selected.panels?.length??0)}
                >
                  既設パネルを削除して再設置
                </button>
              <small>
                現在追跡中の既設パネル: {selected.panels?.length??0}件
              </small>
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
              </details>
            </article>

            <details className="card shiire-disclosure"><summary>割引クーポンを設定する</summary>
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
            </details>
          </section>
        </>
      )}

      <details className="card shiire-disclosure"><summary>販売の注文履歴</summary>
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
      </details>
    </fieldset>
  );
}
