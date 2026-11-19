import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";

type Channel = { id:string; name:string };
type Role = { id:string; name:string; position?:number };

type Machine = {
  id:string;
  guild_id:string;
  owner_id:string;
  name:string;
  public_log_channel_id:string|null;
  local_log_channel_id:string|null;
  private_log_channel_id:string|null;
  role_id:string|null;
  panel_title:string|null;
  panel_description:string|null;
  panel_image_url:string|null;
  panel_color:string|null;
};

type Product = {
  id:string;
  vending_machine_id:string;
  name:string;
  description:string;
  price_paypay:number;
  price_kyash:number;
  emoji:string|null;
  infinite_stock:number;
  infinite_content:string|null;
  sales_count:number;
  stock_count:number;
};

type Coupon = { code:string; discount:number; created_at:number };

type MachineDetail = Machine & {
  products: Product[];
  coupons: Coupon[];
};

type AchievementRoom = {
  id:string;
  guild_id:string;
  owner_id:string;
  channel_id:string;
  machine_ids:string[];
  count_display_enabled:number;
  achievement_count:number;
  base_channel_name:string|null;
  count_name_synced_at:number;
  created_at:number;
  updated_at:number;
};

type AchievementRoomDraft = {
  id:string;
  channelId:string;
  machineIds:string[];
  countDisplayEnabled:boolean;
  achievementCount:number;
  baseChannelName:string|null;
};

type Props = {
  guildId:string;
  channels:Channel[];
  roles:Role[];
  onNotice:(message:string)=>void;
  onError:(reason:unknown)=>void;
  // Set by the "パネル管理" overview when the operator jumps here to edit a
  // specific machine. Applied once per value change, then left alone so the
  // operator's own selection afterwards is never overridden.
  focusMachineId?:string|null;
  // Optional deep link from the console screens: which section / product to open.
  // `key` changes on every request so the same target can be opened again.
  focus?:{machineId:string;section?:"panel"|"products"|"settings"|"achievement";productId?:string|null;key:number}|null;
  onOpenPayments?:()=>void;
};

const emptyProduct = {
  name:"",
  description:"",
  pricePayPay:0,
  priceKyash:0,
  emoji:"",
  infiniteStock:false,
  infiniteContent:""
};

function readFileAsDataUrl(file:File):Promise<string>{
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=()=>resolve(String(reader.result??""));
    reader.onerror=()=>reject(reader.error??new Error("画像の読み込みに失敗しました"));
    reader.readAsDataURL(file);
  });
}

async function preparePanelImage(file:File):Promise<string>{
  const allowed=new Set(["image/png","image/jpeg","image/webp","image/gif"]);
  if(!allowed.has(file.type)) throw new Error("PNG・JPEG・WebP・GIF画像を選択してください");
  if(file.size<=800_000) return readFileAsDataUrl(file);
  if(file.type==="image/gif"){
    throw new Error("GIFはアニメーション維持のため800KB以下のファイルを使用してください");
  }

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
    throw new Error("画像を900KB以下まで圧縮できませんでした。別の画像を選択してください");
  }finally{
    URL.revokeObjectURL(objectUrl);
  }
}

export default function VendingManager({
  guildId, channels, roles, onNotice, onError, focusMachineId, focus, onOpenPayments
}:Props){
  const focusedMachineRef=useRef<string|null>(null);
  const focusedKeyRef=useRef<number|null>(null);
  const pendingProductRef=useRef<string|null>(null);
  const [activeSection,setActiveSection]=useState<"panel"|"products"|"settings"|"achievement">("panel");
  const [mobilePanelView,setMobilePanelView]=useState<"edit"|"preview">("edit");
  const productEditorRef=useRef<HTMLDivElement>(null);
  const [machines,setMachines]=useState<Machine[]>([]);
  const [selectedId,setSelectedId]=useState<string|null>(null);
  const detailRequest=useRef(0);
  const [detailLoading,setDetailLoading]=useState(false);
  const [detail,setDetail]=useState<MachineDetail|null>(null);
  const [newMachineName,setNewMachineName]=useState("");
  const [busy,setBusy]=useState(false);
  const [panelImageBusy,setPanelImageBusy]=useState(false);
  const [panelPreviewMode,setPanelPreviewMode]=useState<"desktop"|"mobile">(
    ()=>window.matchMedia("(max-width: 700px)").matches?"mobile":"desktop"
  );

  const [machineForm,setMachineForm]=useState({
    name:"",
    publicLogChannelId:"",
    localLogChannelId:"",
    privateLogChannelId:"",
    roleId:"",
    panelTitle:"",
    panelDescription:"",
    panelImageUrl:"",
    panelColor:"#57f287"
  });
  const [panelChannel,setPanelChannel]=useState("");
  const [panelMessageUrl,setPanelMessageUrl]=useState("");
  const [notifyEnabled,setNotifyEnabled]=useState(false);
  const [notifyChannel,setNotifyChannel]=useState("");
  const [notifyRole,setNotifyRole]=useState("");
  const [achievementRooms,setAchievementRooms]=useState<AchievementRoomDraft[]>([]);

  const [newProduct,setNewProduct]=useState(emptyProduct);
  const [stockFilter,setStockFilter]=useState<"all"|"finite"|"infinite"|"empty">("all");
  const [editingProduct,setEditingProduct]=useState<Product|null>(null);
  const [productEdit,setProductEdit]=useState({
    name:"",
    description:"",
    pricePayPay:0,
    priceKyash:0,
    emoji:"",
    infiniteStock:false,
    infiniteContent:""
  });
  useEffect(()=>{
    if(activeSection==="products"&&editingProduct){
      productEditorRef.current?.scrollIntoView({block:"start",behavior:"smooth"});
    }
  },[activeSection,editingProduct]);
  const [stockText,setStockText]=useState("");
  const [stockPreview,setStockPreview]=useState<Array<{id:string;content:string}>>([]);
  const [withdrawQuantity,setWithdrawQuantity]=useState(1);

  const [couponCode,setCouponCode]=useState("");
  const [couponDiscount,setCouponDiscount]=useState(100);

  const [paymentStatus,setPaymentStatus]=useState({paypay:false,kyash:false});

  const selected = useMemo(
    ()=>machines.find(machine=>machine.id===selectedId)??null,
    [machines,selectedId]
  );

  const previewProducts = useMemo(()=>{
    if(!detail) return [] as Product[];
    return detail.products.map(product=>{
      if(!editingProduct||editingProduct.id!==product.id) return product;
      return {
        ...product,
        name:productEdit.name,
        description:productEdit.description,
        price_paypay:productEdit.pricePayPay,
        price_kyash:productEdit.priceKyash,
        emoji:productEdit.emoji||null,
        infinite_stock:productEdit.infiniteStock?1:0
      };
    });
  },[detail,editingProduct,productEdit]);

  const panelDirty = detail!==null && (
    machineForm.name!==detail.name ||
    machineForm.panelTitle!==(detail.panel_title??"") ||
    machineForm.panelDescription!==(detail.panel_description??"") ||
    machineForm.panelImageUrl!==(detail.panel_image_url??"") ||
    machineForm.panelColor!==(detail.panel_color??"#57f287") ||
    machineForm.roleId!==(detail.role_id??"") ||
    machineForm.publicLogChannelId!==(detail.public_log_channel_id??"") ||
    machineForm.localLogChannelId!==(detail.local_log_channel_id??"") ||
    machineForm.privateLogChannelId!==(detail.private_log_channel_id??"")
  );

  const productDirty = Boolean(editingProduct) && (
    productEdit.name!==editingProduct!.name ||
    productEdit.description!==editingProduct!.description ||
    productEdit.pricePayPay!==editingProduct!.price_paypay ||
    productEdit.priceKyash!==editingProduct!.price_kyash ||
    productEdit.emoji!==(editingProduct!.emoji??"") ||
    productEdit.infiniteStock!==Boolean(editingProduct!.infinite_stock) ||
    productEdit.infiniteContent!==(editingProduct!.infinite_content??"")
  );
  const stockModeNeedsSave = Boolean(editingProduct) &&
    productEdit.infiniteStock!==Boolean(editingProduct!.infinite_stock);

  const stockSummary = useMemo(()=>{
    const products=detail?.products??[];
    const finite=products.filter(product=>!product.infinite_stock);
    const infinite=products.filter(product=>Boolean(product.infinite_stock));
    const empty=finite.filter(product=>product.stock_count<=0);
    return {
      productCount:products.length,
      finiteProductCount:finite.length,
      infiniteProductCount:infinite.length,
      finiteUnits:finite.reduce((sum,product)=>sum+Math.max(0,product.stock_count),0),
      emptyProductCount:empty.length,
      salesCount:products.reduce((sum,product)=>sum+Math.max(0,product.sales_count),0)
    };
  },[detail]);

  const visibleProducts = useMemo(()=>{
    const products=detail?.products??[];
    if(stockFilter==="finite") return products.filter(product=>!product.infinite_stock);
    if(stockFilter==="infinite") return products.filter(product=>Boolean(product.infinite_stock));
    if(stockFilter==="empty") return products.filter(product=>!product.infinite_stock&&product.stock_count<=0);
    return products;
  },[detail,stockFilter]);

  const editingStockCount = editingProduct
    ? detail?.products.find(product=>product.id===editingProduct.id)?.stock_count ?? editingProduct.stock_count
    : 0;

  const previewChannelName =
    channels.find(channel=>channel.id===panelChannel)?.name ?? "販売";

  async function loadMachines(preferId?:string|null){
    const list=await api<Machine[]>(`/api/guilds/${guildId}/vending`);
    setMachines(list);
    const nextId=
      (preferId&&list.some(vm=>vm.id===preferId)?preferId:null) ??
      (selectedId&&list.some(vm=>vm.id===selectedId)?selectedId:null) ??
      list[0]?.id ??
      null;
    setSelectedId(nextId);
    if(nextId) await loadDetail(nextId);
    else setDetail(null);
  }

  async function loadDetail(id:string){
    const request=++detailRequest.current;
    setDetailLoading(true);
    try{
      const [data,notification]=await Promise.all([
        api<MachineDetail>(`/api/guilds/${guildId}/vending/${id}`),
        api<{channel_id:string;role_id:string;enabled:number}|null>(
          `/api/guilds/${guildId}/vending/${id}/stock-notification`
        )
      ]);
      if(request!==detailRequest.current) return;
      setDetail(data);
      setNotifyEnabled(Boolean(notification?.enabled));
      setNotifyChannel(notification?.channel_id??"");
      setNotifyRole(notification?.role_id??"");
      setMachineForm({
        name:data.name,
        publicLogChannelId:data.public_log_channel_id??"",
        localLogChannelId:data.local_log_channel_id??"",
        privateLogChannelId:data.private_log_channel_id??"",
        roleId:data.role_id??"",
        panelTitle:data.panel_title??"",
        panelDescription:data.panel_description??"",
        panelImageUrl:data.panel_image_url??"",
        panelColor:data.panel_color??"#57f287"
      });
    }finally{
      if(request===detailRequest.current) setDetailLoading(false);
    }
  }

  async function loadPaymentStatus(){
    try{
      const status=await api<{paypay:boolean;kyash:boolean}>("/api/vending/payments/status");
      setPaymentStatus(status);
    }catch(reason){
      onError(reason);
    }
  }

  async function loadAchievementRoom(){
    const result=await api<{rooms:AchievementRoom[]}>(
      `/api/guilds/${guildId}/vending/achievement-room`
    );
    setAchievementRooms(result.rooms.map(room=>({
      id:room.id,
      channelId:room.channel_id,
      machineIds:room.machine_ids,
      countDisplayEnabled:Boolean(room.count_display_enabled),
      achievementCount:room.achievement_count,
      baseChannelName:room.base_channel_name
    })));
  }

  useEffect(()=>{
    void (async()=>{
      try{
        await Promise.all([loadMachines(),loadPaymentStatus(),loadAchievementRoom()]);
      }catch(reason){ onError(reason); }
    })();
  },[guildId]);

  useEffect(()=>{
    if(!focusMachineId||focusMachineId===focusedMachineRef.current) return;
    focusedMachineRef.current=focusMachineId;
    setActiveSection("panel");
    void loadMachines(focusMachineId).catch(onError);
  },[focusMachineId]);

  useEffect(()=>{
    if(!focus||focus.key===focusedKeyRef.current) return;
    focusedKeyRef.current=focus.key;
    // Products / stock are edited on the list screen now.
    setActiveSection(focus.section==="settings"||focus.section==="achievement"?focus.section:"panel");
    pendingProductRef.current=focus.productId??null;
    if(focus.machineId===selectedId&&detail){
      void loadDetail(focus.machineId).catch(onError);
    }else{
      setEditingProduct(null);
      void loadMachines(focus.machineId).catch(onError);
    }
  },[focus]);


  async function persistMachine(){
    if(!selectedId) return;
    await api(`/api/guilds/${guildId}/vending/${selectedId}`,{
      method:"PATCH",
      body:JSON.stringify({
        name:machineForm.name,
        publicLogChannelId:machineForm.publicLogChannelId||null,
        localLogChannelId:machineForm.localLogChannelId||null,
        privateLogChannelId:machineForm.privateLogChannelId||null,
        roleId:machineForm.roleId||null,
        panelTitle:machineForm.panelTitle||null,
        panelDescription:machineForm.panelDescription||null,
        panelImageUrl:machineForm.panelImageUrl||null,
        panelColor:machineForm.panelColor
      })
    });
  }

  async function persistEditingProduct(){
    if(!selectedId||!editingProduct||!productDirty) return;
    if(productEdit.infiniteStock&&!productEdit.infiniteContent.trim()){
      throw new Error("無限在庫の商品は納品内容を入力してください");
    }
    await api(
      `/api/guilds/${guildId}/vending/${selectedId}/products/${editingProduct.id}`,
      {
        method:"PATCH",
        body:JSON.stringify(productEdit)
      }
    );
  }

  async function saveMachine(){
    if(!selectedId) return;
    setBusy(true);
    try{
      await persistMachine();
      await loadMachines(selectedId);
      onNotice("自販機設定を保存しました");
    }catch(reason){onError(reason);}
    finally{setBusy(false);}
  }

  async function uploadPanelImage(file:File){
    if(!selectedId) return;
    setPanelImageBusy(true);
    try{
      const dataUrl=await preparePanelImage(file);
      const result=await api<{url:string}>(
        `/api/guilds/${guildId}/vending/${selectedId}/panel-image`,
        {method:"POST",body:JSON.stringify({dataUrl})},
        30_000
      );
      setMachineForm(current=>({...current,panelImageUrl:result.url}));
      setDetail(current=>current?{...current,panel_image_url:result.url}:current);
      onNotice("パネル画像をアップロードしました");
    }catch(reason){onError(reason);}
    finally{setPanelImageBusy(false);}
  }

  async function removePanelImage(){
    if(!selectedId||!machineForm.panelImageUrl) return;
    setPanelImageBusy(true);
    try{
      await api(
        `/api/guilds/${guildId}/vending/${selectedId}/panel-image`,
        {method:"DELETE"}
      );
      setMachineForm(current=>({...current,panelImageUrl:""}));
      setDetail(current=>current?{...current,panel_image_url:null}:current);
      onNotice("パネル画像を削除しました");
    }catch(reason){onError(reason);}
    finally{setPanelImageBusy(false);}
  }

  async function saveStockNotification(){
    if(!selectedId) return;
    if(notifyEnabled&&(!notifyChannel||!notifyRole)){
      onError(new Error("通知をオンにするには通知チャンネルとメンションロールを選択してください"));
      return;
    }
    setBusy(true);
    try{
      await api(`/api/guilds/${guildId}/vending/${selectedId}/stock-notification`,{
        method:"POST",
        body:JSON.stringify({
          enabled:notifyEnabled,
          channelId:notifyChannel||null,
          roleId:notifyRole||null
        })
      });
      onNotice(notifyEnabled?"在庫追加通知をオンにしました":"在庫追加通知をオフにしました");
    }catch(reason){onError(reason);}
    finally{setBusy(false);}
  }

  async function clearStockNotification(){
    if(!selectedId) return;
    setBusy(true);
    try{
      await api(`/api/guilds/${guildId}/vending/${selectedId}/stock-notification`,{method:"DELETE"});
      setNotifyEnabled(false);
      setNotifyChannel("");
      setNotifyRole("");
      onNotice("在庫追加通知の設定を削除しました");
    }catch(reason){onError(reason);}
    finally{setBusy(false);}
  }

  function addAchievementRoom(){
    if(achievementRooms.length>=20) return;
    setAchievementRooms(current=>[
      ...current,
      {
        id:"new-"+Date.now().toString(36)+"-"+Math.random().toString(36).slice(2,8),
        channelId:"",
        machineIds:[],
        countDisplayEnabled:false,
        achievementCount:0,
        baseChannelName:null
      }
    ]);
  }

  function updateAchievementRoom(
    roomId:string,
    patch:Partial<Pick<AchievementRoomDraft,"channelId"|"machineIds"|"countDisplayEnabled">>
  ){
    setAchievementRooms(current=>current.map(room=>
      room.id===roomId?{...room,...patch}:room
    ));
  }

  function machineAssignedToOtherAchievementRoom(machineId:string,roomId:string){
    return achievementRooms.some(room=>
      room.id!==roomId&&room.machineIds.includes(machineId)
    );
  }

  async function saveAchievementRooms(){
    const validMachineIds=new Set(machines.map(machine=>machine.id));
    if(achievementRooms.some(room=>!room.channelId)){
      onError(new Error("すべての実績部屋でチャンネルを選択してください"));
      return;
    }
    if(achievementRooms.some(room=>room.machineIds.length===0)){
      onError(new Error("すべての実績部屋で通知する自販機を1つ以上選択してください"));
      return;
    }
    const assigned=new Set<string>();
    for(const room of achievementRooms){
      for(const machineId of room.machineIds){
        if(!validMachineIds.has(machineId)){
          onError(new Error("削除済みの自販機が実績部屋設定に含まれています"));
          return;
        }
        if(assigned.has(machineId)){
          onError(new Error("同じ自販機を複数の実績部屋へ設定することはできません"));
          return;
        }
        assigned.add(machineId);
      }
    }

    setBusy(true);
    try{
      const result=await api<{rooms:AchievementRoom[];warnings?:string[]}>(
        `/api/guilds/${guildId}/vending/achievement-room`,
        {
          method:"PUT",
          body:JSON.stringify({
            rooms:achievementRooms.map(room=>({
              id:room.id.startsWith("new-")?undefined:room.id,
              channelId:room.channelId,
              machineIds:room.machineIds,
              countDisplayEnabled:room.countDisplayEnabled
            }))
          })
        }
      );
      setAchievementRooms(result.rooms.map(room=>({
        id:room.id,
        channelId:room.channel_id,
        machineIds:room.machine_ids,
        countDisplayEnabled:Boolean(room.count_display_enabled),
        achievementCount:room.achievement_count,
        baseChannelName:room.base_channel_name
      })));
      const warningText=result.warnings?.length?" "+result.warnings.join(" "):"";
      onNotice("実績部屋の振り分け設定を保存しました。"+warningText);
    }catch(reason){onError(reason);}
    finally{setBusy(false);}
  }

  async function clearAchievementRooms(){
    if(!window.confirm("実績部屋の振り分け設定をすべて解除しますか？")) return;
    setBusy(true);
    try{
      await api(
        `/api/guilds/${guildId}/vending/achievement-room`,
        {method:"PUT",body:JSON.stringify({rooms:[]})}
      );
      setAchievementRooms([]);
      onNotice("実績部屋の振り分けをすべて解除しました");
    }catch(reason){onError(reason);}
    finally{setBusy(false);}
  }

  return (
    <section className="card vending-manager" inert={busy||detailLoading||panelImageBusy} aria-busy={busy||detailLoading||panelImageBusy}>
      <div className="section-head">
        <div>
          <span className="eyebrow">DETAIL SETTINGS</span>
          <h2>{detail?.name??"自販機"} の詳細設定</h2>
          <p className="muted">パネルの文面・画像、購入後ロール、ログ、在庫追加通知、実績部屋を設定します。商品・在庫・帯の色・プレビュー・設置は一覧画面、クーポンは「クーポン管理」で操作します。</p>
        </div>
        <div className="vending-payment-badges">
          <span className={`status-pill ${paymentStatus.paypay?"good":"warn"}`}><i /> PayPay {paymentStatus.paypay?"接続済み":"未接続"}</span>
          <span className={`status-pill ${paymentStatus.kyash?"good":"warn"}`}><i /> Kyash {paymentStatus.kyash?"接続済み":"未接続"}</span>
        </div>
      </div>

      <div className="vending-layout vending-layout-single">

        <div className="vending-main">
          {!selected||!detail ? (
            <div className="vending-select-prompt">
              <strong>読み込み中…</strong>
              <span>自販機の設定を取得しています。</span>
            </div>
          ) : (
            <>
              <nav className="vending-section-nav" aria-label="自販機の管理メニュー">
                {([['panel','パネル文面・ログ'],['settings','在庫追加通知'],['achievement','実績部屋']] as const).map(([id,label])=>(
                  <button type="button" key={id} aria-pressed={activeSection===id} onClick={()=>setActiveSection(id)}>{label}</button>
                ))}
              </nav>
              <div hidden={activeSection!=="panel"} className="vending-tabs-section vending-designer-section">
                <div className="section-head compact">
                  <div>
                    <span className="eyebrow">WYSIWYG PANEL DESIGNER</span>
                    <h3>{detail.name}</h3>
                    <small className="vending-designer-subtitle">
                      設定とプレビューは連動します。帯の色は一覧画面の●から変更できます
                    </small>
                  </div>
                  <div className="button-row">
                    {panelDirty&&(
                      <span className="vending-unsaved">● 未保存</span>
                    )}
                    <button className="primary" onClick={()=>void saveMachine()} disabled={busy}>
                      {busy?"保存中…":"設定を保存"}
                    </button>
                  </div>
                </div>

                <div className="vending-mobile-view" aria-label="パネルの表示切り替え">
                  <button type="button" aria-pressed={mobilePanelView==="edit"} onClick={()=>setMobilePanelView("edit")}>設定を編集</button>
                  <button type="button" aria-pressed={mobilePanelView==="preview"} onClick={()=>setMobilePanelView("preview")}>プレビュー・設置</button>
                </div>
                <div className={`vending-designer-layout vending-view-${mobilePanelView}`}>
                  <div className="vending-designer-controls">
                    <div className="vending-control-group">
                      <span className="vending-control-title">基本設定</span>
                      <label className="field">
                        <span>自販機名</span>
                        <input
                          value={machineForm.name}
                          onChange={e=>setMachineForm({...machineForm,name:e.target.value})}
                          maxLength={80}
                        />
                      </label>
                      <label className="field">
                        <span>購入後ロール</span>
                        <select
                          value={machineForm.roleId}
                          onChange={e=>setMachineForm({...machineForm,roleId:e.target.value})}
                        >
                          <option value="">付与なし</option>
                          {roles.map(role=><option key={role.id} value={role.id}>@{role.name}</option>)}
                        </select>
                      </label>
                    </div>

                    <div className="vending-control-group">
                      <span className="vending-control-title">パネルデザイン</span>
                      <label className="field">
                        <span>タイトル</span>
                        <input
                          value={machineForm.panelTitle}
                          onChange={e=>setMachineForm({...machineForm,panelTitle:e.target.value})}
                          placeholder={machineForm.name||"自販機"}
                          maxLength={256}
                        />
                      </label>
                      <label className="field">
                        <span>説明</span>
                        <textarea
                          value={machineForm.panelDescription}
                          onChange={e=>setMachineForm({...machineForm,panelDescription:e.target.value})}
                          placeholder="購入したい商品を下のボタンから選択してください。"
                          maxLength={3000}
                        />
                      </label>
                      <div className="field">
                        <span>パネル画像</span>
                        <div className="vending-image-upload-row">
                          <label className="secondary vending-file-button vending-image-upload-button">
                            {panelImageBusy?"画像を処理中…":"画像をアップロード"}
                            <input
                              type="file"
                              accept="image/png,image/jpeg,image/webp,image/gif"
                              disabled={panelImageBusy}
                              onChange={(event)=>{
                                const input=event.currentTarget;
                                const file=input.files?.[0];
                                if(!file) return;
                                void uploadPanelImage(file).finally(()=>{input.value="";});
                              }}
                            />
                          </label>
                          {machineForm.panelImageUrl&&(
                            <button
                              type="button"
                              className="danger"
                              onClick={()=>void removePanelImage()}
                              disabled={panelImageBusy}
                            >
                              画像を削除
                            </button>
                          )}
                        </div>
                        <small className="vending-field-help">
                          URL入力は不要です。大きな写真は自動で縮小・圧縮します。GIFは800KB以下にしてください。
                        </small>
                      </div>
                    </div>

                    <details className="vending-advanced-settings">
                      <summary>ログ・通知設定</summary>
                      <div className="form-grid two">
                        <label className="field"><span>公開販売ログ</span>
                          <select value={machineForm.publicLogChannelId} onChange={e=>setMachineForm({...machineForm,publicLogChannelId:e.target.value})}>
                            <option value="">未設定</option>
                            {channels.map(channel=><option key={channel.id} value={channel.id}>#{channel.name}</option>)}
                          </select>
                        </label>
                        <label className="field"><span>このサーバーの購入ログ</span>
                          <select value={machineForm.localLogChannelId} onChange={e=>setMachineForm({...machineForm,localLogChannelId:e.target.value})}>
                            <option value="">未設定</option>
                            {channels.map(channel=><option key={channel.id} value={channel.id}>#{channel.name}</option>)}
                          </select>
                        </label>
                        <label className="field"><span>非公開ログ</span>
                          <select value={machineForm.privateLogChannelId} onChange={e=>setMachineForm({...machineForm,privateLogChannelId:e.target.value})}>
                            <option value="">未設定</option>
                            {channels.map(channel=><option key={channel.id} value={channel.id}>#{channel.name}</option>)}
                          </select>
                        </label>
                      </div>
                    </details>
                  </div>

                  <div className="vending-preview-pane">
                    <div className="vending-preview-toolbar">
                      <div>
                        <span className="eyebrow">LIVE PREVIEW</span>
                        <strong>Discord表示</strong>
                      </div>
                      <div className="vending-preview-size">
                        <button
                          type="button"
                          className={panelPreviewMode==="desktop"?"active":""}
                          onClick={()=>setPanelPreviewMode("desktop")}
                        >
                          PC
                        </button>
                        <button
                          type="button"
                          className={panelPreviewMode==="mobile"?"active":""}
                          onClick={()=>setPanelPreviewMode("mobile")}
                        >
                          MOBILE
                        </button>
                      </div>
                    </div>

                    <div className={`vending-discord-stage ${panelPreviewMode}`}>
                      <div className="vending-discord-window">
                        <div className="vending-discord-channelbar">
                          <span>#</span>
                          <strong>{previewChannelName}</strong>
                        </div>

                        <div className="vending-discord-message">
                          <div className="vending-bot-avatar">D</div>
                          <div className="vending-message-body">
                            <div className="vending-message-author">
                              <strong>CHICKEN🐣BOT</strong>
                              <span className="vending-bot-tag">BOT</span>
                              <small>今日 04:14</small>
                            </div>

                            <div className="vending-discord-embed" style={{["--embed-color" as string]:machineForm.panelColor}}>
                              <input
                                className="vending-wysiwyg-title"
                                value={machineForm.panelTitle}
                                onChange={e=>setMachineForm({...machineForm,panelTitle:e.target.value})}
                                placeholder={machineForm.name||"自販機"}
                                aria-label="パネルタイトル"
                                maxLength={256}
                              />

                              <textarea
                                className="vending-wysiwyg-description"
                                value={machineForm.panelDescription}
                                onChange={e=>setMachineForm({...machineForm,panelDescription:e.target.value})}
                                placeholder="購入したい商品を下のボタンから選択してください。"
                                aria-label="パネル説明"
                                maxLength={3000}
                              />

                              <div className="vending-preview-products">
                                {previewProducts.length ? previewProducts.map(product=>(
                                  <div
                                    className="vending-preview-product"
                                    key={product.id}
                                  >
                                    <strong>{product.emoji?product.emoji+" ":""}{product.name}</strong>
                                    <span>
                                      PayPay: {product.price_paypay}円 / Kyash: {product.price_kyash}円 / 在庫: {product.infinite_stock?"∞":product.stock_count} / 販売: {product.sales_count}
                                    </span>
                                  </div>
                                )):(
                                  <div className="vending-preview-empty-product">
                                    現在販売中の商品はありません。
                                  </div>
                                )}
                              </div>

                              {machineForm.panelImageUrl&&(
                                <img
                                  className="vending-preview-image"
                                  src={machineForm.panelImageUrl}
                                  alt="パネル画像プレビュー"
                                />
                              )}
                            </div>

                            <div className="vending-discord-components">
                              <button type="button" className="discord-component green" tabIndex={-1}>
                                <span>🛒</span> 購入する
                              </button>
                              <button type="button" className="discord-component blue" tabIndex={-1}>
                                <span>📦</span> 在庫・販売数
                              </button>
                            </div>

                            <div className="vending-preview-match">
                              <span>✓</span>
                              表示内容・順序は実際のDiscord送信内容と同じです。フォントや余白はDiscordアプリ側で多少変わる場合があります。
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>

                  </div>
                </div>
              </div>

              <div hidden={activeSection!=="settings"} className="vending-settings-single">
                <div className="vending-tabs-section">
                  <div className="section-head compact">
                    <div>
                      <span className="eyebrow">STOCK ALERT</span>
                      <h3>在庫追加通知</h3>
                    </div>
                    <span className={`status-pill ${notifyEnabled?"good":"warn"}`}>
                      <i /> {notifyEnabled?"ON":"OFF"}
                    </span>
                  </div>

                  <label className="toggle-row compact-toggle vending-notify-toggle">
                    <span className="toggle-copy">
                      <strong>在庫を追加した時に通知する</strong>
                      <small>
                        {notifyEnabled
                          ?"ON: 有限在庫を追加した時に指定チャンネルへ通知します"
                          :"OFF: 在庫を追加してもDiscordへ通知しません"}
                      </small>
                    </span>
                    <input
                      type="checkbox"
                      checked={notifyEnabled}
                      onChange={e=>setNotifyEnabled(e.target.checked)}
                    />
                  </label>

                  <label className="field"><span>通知チャンネル</span>
                    <select value={notifyChannel} onChange={e=>setNotifyChannel(e.target.value)}>
                      <option value="">選択</option>
                      {channels.map(channel=><option key={channel.id} value={channel.id}>#{channel.name}</option>)}
                    </select>
                  </label>
                  <label className="field"><span>メンションロール</span>
                    <select value={notifyRole} onChange={e=>setNotifyRole(e.target.value)}>
                      <option value="">選択</option>
                      {roles.map(role=><option key={role.id} value={role.id}>@{role.name}</option>)}
                    </select>
                  </label>
                  <small className="vending-field-help">
                    デフォルトはOFFです。OFFのまま通知先だけ先に保存しておくこともできます。
                  </small>
                  <div className="button-row">
                    <button
                      className="secondary"
                      onClick={()=>void saveStockNotification()}
                      disabled={busy||(notifyEnabled&&(!notifyChannel||!notifyRole))}
                    >
                      通知設定を保存
                    </button>
                    <button
                      className="danger"
                      onClick={()=>void clearStockNotification()}
                      disabled={busy||(!notifyChannel&&!notifyRole)}
                    >
                      設定を削除
                    </button>
                  </div>
                </div>


              </div>

              <div hidden={activeSection!=="achievement"} className="vending-tabs-section">
                <div className="section-head compact">
                  <div>
                    <span className="eyebrow">ACHIEVEMENT ROUTING</span>
                    <h3>実績部屋の振り分け</h3>
                    <p className="muted">
                      自販機ごとに実績の送信先を分けられます。例: 自販機A/B → #実績1、自販機C → #実績2。
                    </p>
                  </div>
                  <button
                    className="secondary"
                    type="button"
                    onClick={addAchievementRoom}
                    disabled={achievementRooms.length>=20||busy}
                  >
                    ＋ 実績部屋を追加
                  </button>
                </div>

                {achievementRooms.length===0 ? (
                  <div className="vending-select-prompt">
                    <strong>実績部屋はまだありません</strong>
                    <span>「＋ 実績部屋を追加」から送信先と対象自販機を設定してください。</span>
                  </div>
                ) : (
                  <div className="stack">
                    {achievementRooms.map((room,index)=>(
                      <article className="vending-control-group" key={room.id}>
                        <div className="section-head compact">
                          <div>
                            <span className="eyebrow">ROUTE {index+1}</span>
                            <h3>
                              {room.channelId
                                ? "#"+(channels.find(channel=>channel.id===room.channelId)?.name??"実績部屋")
                                : "送信先を選択"}
                            </h3>
                          </div>
                          <button
                            className="danger"
                            type="button"
                            onClick={()=>setAchievementRooms(current=>current.filter(item=>item.id!==room.id))}
                            disabled={busy}
                          >
                            この振り分けを削除
                          </button>
                        </div>

                        <label className="field"><span>実績を送るチャンネル</span>
                          <select
                            value={room.channelId}
                            onChange={event=>updateAchievementRoom(room.id,{channelId:event.target.value})}
                          >
                            <option value="">選択</option>
                            {channels.map(channel=>(
                              <option key={channel.id} value={channel.id}>#{channel.name}</option>
                            ))}
                          </select>
                        </label>

                        <div className="field">
                          <span>この実績部屋へ送る自販機</span>
                          <div className="role-picker">
                            {machines.map(machine=>{
                              const checked=room.machineIds.includes(machine.id);
                              const usedElsewhere=machineAssignedToOtherAchievementRoom(machine.id,room.id);
                              return (
                                <label
                                  key={machine.id}
                                  className={`role-choice ${checked?"selected":""}`}
                                  title={usedElsewhere?"別の実績部屋に設定済み":undefined}
                                >
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    disabled={usedElsewhere}
                                    onChange={event=>{
                                      updateAchievementRoom(room.id,{
                                        machineIds:event.target.checked
                                          ? [...new Set([...room.machineIds,machine.id])]
                                          : room.machineIds.filter(id=>id!==machine.id)
                                      });
                                    }}
                                  />
                                  <span>
                                    {machine.name}{usedElsewhere&&!checked?" — 他の実績部屋に設定済み":""}
                                  </span>
                                </label>
                              );
                            })}
                          </div>
                        </div>
                        <div className="vending-achievement-count-setting">
                          <label className="toggle-row compact-toggle">
                            <span className="toggle-copy">
                              <strong>チャンネル名に実績件数を表示</strong>
                              <small>
                                {room.countDisplayEnabled
                                  ? "ON: チャンネル名の末尾に「"+room.achievementCount+"件」を表示します"
                                  : "OFF: チャンネル名は変更しません"}
                              </small>
                            </span>
                            <input
                              type="checkbox"
                              checked={room.countDisplayEnabled}
                              onChange={event=>updateAchievementRoom(room.id,{
                                countDisplayEnabled:event.target.checked
                              })}
                            />
                          </label>
                          <div className="vending-achievement-count-preview">
                            <span>現在の実績件数</span>
                            <strong>{room.achievementCount}件</strong>
                            {room.countDisplayEnabled&&room.channelId&&(
                              <small>
                                表示例: #
                                {(room.baseChannelName
                                  ?? channels.find(channel=>channel.id===room.channelId)?.name
                                  ?? "実績")
                                  .replace(/\d+件$/,"")}
                                {room.achievementCount}件
                              </small>
                            )}
                          </div>
                        </div>
                        <small className="muted">
                          {room.machineIds.length}台の自販機をこの部屋へ振り分け。件数表示はデフォルトOFFです。
                        </small>
                      </article>
                    ))}
                  </div>
                )}

                <div className="button-row">
                  <button
                    className="primary"
                    type="button"
                    onClick={()=>void saveAchievementRooms()}
                    disabled={
                      busy||
                      achievementRooms.some(room=>!room.channelId||room.machineIds.length===0)
                    }
                  >
                    振り分け設定を保存
                  </button>
                  <button
                    className="danger"
                    type="button"
                    onClick={()=>void clearAchievementRooms()}
                    disabled={achievementRooms.length===0||busy}
                  >
                    すべて解除
                  </button>
                </div>
                <small className="muted">
                  1台の自販機は1つの実績部屋に割り当てます。通知内容: 購入者 / 商品名 / 個数 / 注文ID。
                  件数は実績メッセージの送信成功時に加算され、Discordのチャンネル名変更制限を避けるため名前への反映は数分遅れる場合があります。
                </small>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
