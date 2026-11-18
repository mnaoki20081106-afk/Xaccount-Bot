import { Fragment, ReactNode, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { ConsoleChannel, VmMachine, channelName, postableChannels } from "./console-ui";
import type { ConsoleView } from "./DashboardOverview";

type Asset = {
  id:string;
  name:string;
  title:string;
  body:string;
  color:string;
  image_url:string|null;
  thumbnail_url:string|null;
  footer:string|null;
  vending_machine_id:string|null;
  channel_id:string|null;
  message_id:string|null;
  updated_at:number;
};

type Draft = {
  name:string; title:string; body:string; color:string;
  imageUrl:string; thumbnailUrl:string; footer:string; vendingMachineId:string;
};

const emptyDraft:Draft={name:"",title:"",body:"",color:"#3867d6",imageUrl:"",thumbnailUrl:"",footer:"",vendingMachineId:""};

function toDraft(asset:Asset):Draft{
  return {
    name:asset.name,title:asset.title,body:asset.body,color:asset.color,
    imageUrl:asset.image_url??"",thumbnailUrl:asset.thumbnail_url??"",footer:asset.footer??"",
    vendingMachineId:asset.vending_machine_id??""
  };
}

/** Minimal Discord-markdown preview: # / ## / ### headings and **bold**. */
function inline(text:string):ReactNode[]{
  return text.split(/(\*\*[^*]+\*\*)/g).map((part,index)=>
    part.startsWith("**")&&part.endsWith("**")&&part.length>4
      ?<strong key={index}>{part.slice(2,-2)}</strong>
      :<Fragment key={index}>{part}</Fragment>
  );
}
function renderBody(body:string){
  return body.split("\n").map((line,index)=>{
    const heading=line.match(/^(#{1,3})\s+(.*)$/);
    if(heading){
      const size=[20,17,15][heading[1]!.length-1];
      return <h3 key={index} style={{fontSize:size}}>{inline(heading[2]!)}</h3>;
    }
    return <div key={index}>{line?inline(line):" "}</div>;
  });
}

export default function AssetManager({
  guildId, channels, onNavigate, onNotice, onError
}:{
  guildId:string;
  channels:ConsoleChannel[];
  onNavigate:(view:ConsoleView)=>void;
  onNotice:(message:string)=>void;
  onError:(reason:unknown)=>void;
}){
  const [assets,setAssets]=useState<Asset[]>([]);
  const [machines,setMachines]=useState<VmMachine[]>([]);
  const [selectedId,setSelectedId]=useState<string>("");
  const [draft,setDraft]=useState<Draft>(emptyDraft);
  const [saved,setSaved]=useState<Draft>(emptyDraft);
  const [channelId,setChannelId]=useState("");
  const [utilityKind,setUtilityKind]=useState<"shadowban"|"2fa"|"account-format">("shadowban");
  const [utilityChannel,setUtilityChannel]=useState("");
  const [busy,setBusy]=useState(false);
  const bodyRef=useRef<HTMLTextAreaElement>(null);

  const postable=postableChannels(channels);
  const selected=assets.find(asset=>asset.id===selectedId)??null;
  const dirty=JSON.stringify(draft)!==JSON.stringify(saved);
  const machine=machines.find(row=>row.id===draft.vendingMachineId)??null;

  async function load(){
    try{
      const [list,vm]=await Promise.all([
        api<Asset[]>(`/api/guilds/${guildId}/vending/assets`),
        api<VmMachine[]>(`/api/guilds/${guildId}/vending`)
      ]);
      setAssets(list);
      setMachines(vm);
    }catch(reason){ onError(reason); }
  }

  useEffect(()=>{ void load(); },[guildId]);

  function open(asset:Asset|null){
    if(dirty&&!window.confirm("保存していない変更があります。破棄しますか？")) return;
    const next=asset?toDraft(asset):emptyDraft;
    setSelectedId(asset?.id??"");
    setDraft(next);
    setSaved(next);
    setChannelId(asset?.channel_id??"");
  }

  function insert(prefix:string,suffix=""){
    const element=bodyRef.current;
    const start=element?.selectionStart??draft.body.length;
    const end=element?.selectionEnd??draft.body.length;
    const chosen=draft.body.slice(start,end)||(suffix?"太字":"見出し");
    const lineStart=prefix==="# "?draft.body.lastIndexOf("\n",start-1)+1:start;
    const body=prefix==="# "
      ?draft.body.slice(0,lineStart)+"# "+draft.body.slice(lineStart)
      :draft.body.slice(0,start)+prefix+chosen+suffix+draft.body.slice(end);
    setDraft({...draft,body});
    requestAnimationFrame(()=>element?.focus());
  }

  async function save():Promise<Asset|null>{
    setBusy(true);
    try{
      const payload=JSON.stringify(draft);
      const asset=selected
        ?await api<Asset>(`/api/guilds/${guildId}/vending/assets/${selected.id}`,{method:"PUT",body:payload})
        :await api<Asset>(`/api/guilds/${guildId}/vending/assets`,{method:"POST",body:payload});
      await load();
      setSelectedId(asset.id);
      const next=toDraft(asset);
      setDraft(next);
      setSaved(next);
      onNotice("パネル「"+asset.name+"」を保存しました");
      return asset;
    }catch(reason){ onError(reason); return null; }
    finally{ setBusy(false); }
  }

  async function deploy(mode:"new"|"update"){
    const asset=dirty||!selected?await save():selected;
    if(!asset) return;
    if(mode==="new"&&!channelId){ onError(new Error("設置先チャンネルを選択してください")); return; }
    setBusy(true);
    try{
      const result=await api<{channelId:string}>(`/api/guilds/${guildId}/vending/assets/${asset.id}/deploy`,{
        method:"POST",body:JSON.stringify({channelId,mode})
      });
      await load();
      onNotice(mode==="update"
        ?"設置済みパネルを更新しました"
        :"パネルを #"+(channelName(channels,result.channelId)??result.channelId)+" に設置しました");
    }catch(reason){ onError(reason); }
    finally{ setBusy(false); }
  }

  // X-Utility is a separate bot: Xaccount-Bot only relays the request and the
  // X-Utility bot itself posts the panel, so it needs access to the channel.
  async function deployUtility(){
    if(!utilityChannel) return;
    setBusy(true);
    try{
      await api(`/api/guilds/${guildId}/xutility/${utilityKind}/panel`,{method:"POST",body:JSON.stringify({channelId:utilityChannel})},30_000);
      onNotice("X-Utility BOTがパネルを #"+(channelName(channels,utilityChannel)??utilityChannel)+" に設置しました");
    }catch(reason){ onError(reason); }
    finally{ setBusy(false); }
  }

  async function remove(asset:Asset){
    if(!window.confirm(`保存済みパネル「${asset.name}」を削除しますか？（Discordに設置済みのメッセージは残ります）`)) return;
    setBusy(true);
    try{
      await api(`/api/guilds/${guildId}/vending/assets/${asset.id}`,{method:"DELETE"});
      if(asset.id===selectedId){ setSelectedId(""); setDraft(emptyDraft); setSaved(emptyDraft); }
      await load();
      onNotice("パネルを削除しました");
    }catch(reason){ onError(reason); }
    finally{ setBusy(false); }
  }

  return (
    <>
      <div className="xc-page-head" style={{borderBottom:"1px solid #1c2440",paddingBottom:16}}>
        <div>
          <h1>パネル作成</h1>
          <p>案内・規約・告知などのEmbedパネルを作成し、Discordへ設置・更新できます。自販機ボタンを付けると購入パネルとしても使えます。</p>
        </div>
        <div style={{display:"flex",gap:8}}>
          <select className="xc-input" style={{width:"auto"}} value={selectedId} aria-label="編集するパネル"
            onChange={event=>open(assets.find(asset=>asset.id===event.target.value)??null)}>
            <option value="">(新規作成中)</option>
            {assets.map(asset=><option key={asset.id} value={asset.id}>{asset.name}</option>)}
          </select>
          <button type="button" className="xc-btn ghost" onClick={()=>open(null)}>新規</button>
        </div>
      </div>

      <div className="xc-asset-grid">
        <section className="xc-card">
          <div className="xc-form">
            <div className="two">
              <label>パネル名
                <input value={draft.name} maxLength={80} onChange={event=>setDraft({...draft,name:event.target.value})} placeholder="例: 案内, 規約" />
              </label>
              <label>自販機ボタン（任意）
                <select value={draft.vendingMachineId} onChange={event=>setDraft({...draft,vendingMachineId:event.target.value})}>
                  <option value="">なし（案内のみ）</option>
                  {machines.map(row=><option key={row.id} value={row.id}>{row.name}</option>)}
                </select>
              </label>
            </div>
            <div className="title-color">
              <label>タイトル（省略可）
                <input value={draft.title} maxLength={256} onChange={event=>setDraft({...draft,title:event.target.value})} />
              </label>
              <label>帯カラー
                <span className="xc-color">
                  <input type="color" value={draft.color} aria-label="帯カラーを選択" onChange={event=>setDraft({...draft,color:event.target.value})} />
                  <input type="text" value={draft.color} maxLength={7} aria-label="帯カラーのHEX"
                    onChange={event=>setDraft({...draft,color:event.target.value})} />
                </span>
              </label>
            </div>
            <label>
              <span className="xc-body-head">
                <span>本文</span>
                <span style={{display:"flex",gap:6}}>
                  <button type="button" className="xc-btn tiny edit" onClick={()=>insert("# ")}># 見出し</button>
                  <button type="button" className="xc-btn tiny edit" onClick={()=>insert("**","**")}>**太字**</button>
                </span>
              </span>
              <textarea ref={bodyRef} value={draft.body} maxLength={4000} onChange={event=>setDraft({...draft,body:event.target.value})} />
            </label>
            <details>
              <summary>オプション（画像・フッター）▼</summary>
              <div className="xc-form">
                <label>画像URL（https）<input value={draft.imageUrl} onChange={event=>setDraft({...draft,imageUrl:event.target.value})} placeholder="https://..." /></label>
                <label>サムネイルURL（https）<input value={draft.thumbnailUrl} onChange={event=>setDraft({...draft,thumbnailUrl:event.target.value})} placeholder="https://..." /></label>
                <label>フッター<input value={draft.footer} maxLength={2048} onChange={event=>setDraft({...draft,footer:event.target.value})} /></label>
              </div>
            </details>
            <div className="xc-form-footer">
              <button type="button" className="xc-btn violet" disabled={busy||!dirty&&Boolean(selected)} onClick={()=>void save()}>パネルを保存</button>
              {dirty&&selected&&<span className="muted" style={{alignSelf:"center",fontSize:13}}>● 未保存の変更があります</span>}
            </div>
          </div>
        </section>

        <div style={{display:"grid",gap:22}}>
          <section className="xc-card">
            <div className="muted" style={{fontSize:13,fontWeight:800,marginBottom:12}}>プレビュー</div>
            <div className="xc-discord-preview">
              <div className="xc-discord-author">
                <span className="xc-discord-avatar">Bot</span>
                <strong>Xaccount-Bot</strong>
                <span className="xc-app-tag">アプリ</span>
              </div>
              <div className="xc-discord-embed" style={{borderLeftColor:/^#[0-9a-f]{6}$/i.test(draft.color)?draft.color:"#3867d6"}}>
                <div className="embed-row">
                  <div style={{display:"grid",gap:8,minWidth:0}}>
                    {draft.title&&<h4>{draft.title}</h4>}
                    {draft.body.trim()&&<div className="embed-body">{renderBody(draft.body)}</div>}
                    {!draft.title&&!draft.body.trim()&&<div className="embed-body" style={{color:"#949ba4"}}>タイトルか本文を入力するとここに表示されます</div>}
                  </div>
                  {draft.thumbnailUrl&&<img className="embed-thumb" src={draft.thumbnailUrl} alt="" />}
                </div>
                {draft.imageUrl&&<img className="embed-image" src={draft.imageUrl} alt="" />}
                {draft.footer&&<footer>{draft.footer}</footer>}
              </div>
              {machine&&(
                <div className="xc-discord-buttons">
                  <span className="green">🛒 購入する</span>
                  <span className="blurple">📦 在庫・販売数</span>
                </div>
              )}
            </div>
            <div className="xc-inline-form" style={{marginTop:14,marginBottom:0}}>
              <div className="row">
                <label>設置先チャンネル
                  <select value={channelId} onChange={event=>setChannelId(event.target.value)}>
                    <option value="">設置先チャンネルを選択...</option>
                    {postable.map(channel=>(
                      <option key={channel.id} value={channel.id} disabled={channel.botCanPost===false}>
                        #{channel.name}{channel.botCanPost===false?" — BOTアクセス不可":""}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="button" className="xc-btn violet" disabled={busy||!channelId||(!draft.title&&!draft.body.trim())||!draft.name.trim()} onClick={()=>void deploy("new")}>設置</button>
                {selected?.message_id&&(
                  <button type="button" className="xc-btn green" disabled={busy} onClick={()=>void deploy("update")}>設置済みを更新</button>
                )}
              </div>
              {selected?.channel_id&&(
                <small className="muted">
                  設置済み: #{channelName(channels,selected.channel_id)}
                  {selected.message_id&&<> · <a href={`https://discord.com/channels/${guildId}/${selected.channel_id}/${selected.message_id}`} target="_blank" rel="noreferrer">メッセージを開く ↗</a></>}
                </small>
              )}
            </div>
          </section>

          <section className="xc-card">
            <div className="xc-page-head" style={{marginBottom:12}}>
              <strong className="muted" style={{fontSize:14}}>保存済みパネル</strong>
              <span className="muted" style={{fontSize:13}}>{assets.length}件</span>
            </div>
            {assets.length===0?(
              <div className="xc-empty">アセットはまだ作成されていません。左のフォームから作成して「パネルを保存」してください。</div>
            ):(
              <div className="xc-asset-list">
                {assets.map(asset=>(
                  <div key={asset.id} className={`xc-asset-row ${asset.id===selectedId?"active":""}`}>
                    <button type="button" className="open" onClick={()=>open(asset)}>
                      <strong>{asset.name}</strong>
                      <small>
                        {asset.channel_id?"設置済み #"+channelName(channels,asset.channel_id):"未設置"}
                        {asset.vending_machine_id?" · 自販機ボタン付き":""}
                      </small>
                    </button>
                    <button type="button" className="xc-btn tiny del" disabled={busy} onClick={()=>void remove(asset)}>削除</button>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="xc-card">
            <strong className="muted" style={{fontSize:14}}>ほかのパネル（機能ごとに専用画面で設置）</strong>
            <div className="xc-link-list" style={{marginTop:12}}>
              <div className="xc-link-row"><span>自販機パネル<small>Xaccount-Bot · 商品一覧付きの購入パネル</small></span><button type="button" className="xc-btn tiny edit" onClick={()=>onNavigate("vending")}>開く</button></div>
              <div className="xc-link-row"><span>認証 / チケットパネル<small>Xaccount-Bot</small></span><span style={{display:"flex",gap:6}}><button type="button" className="xc-btn tiny edit" onClick={()=>onNavigate("verification")}>認証</button><button type="button" className="xc-btn tiny edit" onClick={()=>onNavigate("tickets")}>チケット</button></span></div>
              <div className="xc-link-row"><span>仕入れbot 自販機パネル<small className="xc-nav-copy" style={{color:"#f5b77a"}}>別Bot · Discord-Shiire</small></span><button type="button" className="xc-btn tiny edit" onClick={()=>onNavigate("shiire")}>開く</button></div>
              <div className="xc-link-row" style={{display:"grid",gap:10}}>
                <span>X-Utility パネル<small style={{color:"#f5b77a"}}>別Bot · X-Utility が投稿します（X-Utility BOTのサーバー参加・チャンネル権限が必要）</small></span>
                <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                  <select className="xc-input" style={{flex:"1 1 150px",width:"auto"}} value={utilityKind} aria-label="X-Utilityパネルの種類" onChange={event=>setUtilityKind(event.target.value as typeof utilityKind)}>
                    <option value="shadowban">X 垢状態チェック</option>
                    <option value="2fa">2FAコード生成</option>
                    <option value="account-format">アカウント形式判別</option>
                  </select>
                  <select className="xc-input" style={{flex:"1 1 150px",width:"auto"}} value={utilityChannel} aria-label="X-Utilityパネルの設置先" onChange={event=>setUtilityChannel(event.target.value)}>
                    <option value="">設置先...</option>
                    {postable.map(channel=><option key={channel.id} value={channel.id}>#{channel.name}</option>)}
                  </select>
                  <button type="button" className="xc-btn tiny stock" disabled={busy||!utilityChannel} onClick={()=>void deployUtility()}>設置</button>
                  <button type="button" className="xc-btn tiny edit" onClick={()=>onNavigate("utility")}>詳細</button>
                </div>
              </div>
              <div className="xc-link-row"><span>設置済みパネル一覧<small>全Botのパネルの設置先・在庫</small></span><button type="button" className="xc-btn tiny edit" onClick={()=>onNavigate("panels")}>開く</button></div>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
