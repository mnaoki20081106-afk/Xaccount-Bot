import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { panelPayload, panelSections, type PanelMachine, type PanelProduct } from "./shiire-panel-payload";

const markdownPlugins=[remarkGfm];
function previewMarkdown(text:string){
  return text.replace(/^\n\n/,"").split(/(```[\s\S]*?```)/g)
    .map((part,index)=>index%2?part:part.replace(/(?<!\n)\n(?!\n)/g,"  \n")).join("");
}
export default function ShiirePanelPreview({machine,products,onTitle,onDescription,onProduct,editingProductId,onProductChange,disabled}: {
  machine:PanelMachine;products:PanelProduct[];onTitle:(value:string)=>void;onDescription:(value:string)=>void;
  onProduct:(id:string)=>void;editingProductId:string;onProductChange:(patch:Partial<PanelProduct>)=>void;disabled:boolean;
}){
  const [editing,setEditing]=useState<"title"|"description"|null>(null);
  const [mobile,setMobile]=useState(false);
  const [viewOnly,setViewOnly]=useState(false);
  const renderedProducts=products.map(product=>({...product,name:product.name.trim()||"Xアカウント"}));
  const payload=panelPayload(machine,renderedProducts);
  const embed=payload.embeds[0];
  return <section className="shiire-panel-studio" aria-label="自販機パネルのプレビュー">
    <div className="section-head"><div><h3>パネルを見ながら編集</h3><p>タイトル・説明・商品を選んで編集できます。変更後は保存して反映してください。</p></div>
      <div className="button-row" aria-label="プレビュー幅"><button type="button" className="secondary" aria-pressed={viewOnly} onClick={()=>{setEditing(null);setViewOnly(value=>!value);}}>{viewOnly?"編集に戻る":"表示のみ"}</button><button type="button" className="secondary" aria-pressed={!mobile} onClick={()=>setMobile(false)}>PC</button><button type="button" className="secondary" aria-pressed={mobile} onClick={()=>setMobile(true)}>スマホ</button></div>
    </div>
    <div className={"discord-panel-preview"+(mobile?" is-mobile":"")} data-testid="discord-panel-preview">
      <div className="discord-panel-embed" style={{borderLeftColor:"#"+embed.color.toString(16).padStart(6,"0")}}>
        {!viewOnly&&editing==="title"?<input className="discord-inline-input discord-panel-title" aria-label="プレビューのタイトル" autoFocus maxLength={256} value={machine.panel_title??""} placeholder={machine.name||"仕入れBOT自販機"} onChange={e=>onTitle(e.target.value)} onBlur={()=>setEditing(null)} disabled={disabled}/>
          :viewOnly?<div className="discord-panel-title">{embed.title}</div>:<button type="button" className="discord-panel-title discord-editable" aria-label="プレビューのタイトルを編集" onClick={()=>setEditing("title")} disabled={disabled}>{embed.title}</button>}
        <div className="discord-panel-description">
          {panelSections(machine,renderedProducts).map(section=>section.id==="description"&&!viewOnly&&editing==="description"
            ?<textarea key={section.id} className="discord-inline-input" aria-label="プレビューの説明" autoFocus maxLength={3000} rows={4} value={machine.panel_description??""} placeholder="購入したい商品を下のボタンから選択してください。" onChange={e=>onDescription(e.target.value)} onBlur={()=>setEditing(null)} disabled={disabled}/>
            :!viewOnly&&section.id===editingProductId? <div key={section.id} className="discord-product-editor">
              <label>商品名<input className="discord-inline-input" aria-label="プレビューの商品名" maxLength={80} value={products.find(p=>p.id===section.id)?.name??""} disabled={disabled} onChange={e=>onProductChange({name:e.target.value})}/></label>
              <label>商品説明<textarea className="discord-inline-input" aria-label="プレビューの商品説明" maxLength={500} rows={3} value={products.find(p=>p.id===section.id)?.description??""} disabled={disabled} onChange={e=>onProductChange({description:e.target.value})}/></label>
              <div className="discord-price-editor"><label>PayPay<input className="discord-inline-input" aria-label="プレビューのPayPay価格" type="number" min={0} value={products.find(p=>p.id===section.id)?.price_paypay??0} disabled={disabled} onChange={e=>onProductChange({price_paypay:Number(e.target.value)})}/></label><label>Kyash<input className="discord-inline-input" aria-label="プレビューのKyash価格" type="number" min={0} value={products.find(p=>p.id===section.id)?.price_kyash??0} disabled={disabled} onChange={e=>onProductChange({price_kyash:Number(e.target.value)})}/></label></div>
            </div>
            :<div key={section.id} className={(viewOnly||section.id==="empty")?"discord-panel-section":"discord-panel-section discord-editable"} role={(viewOnly||section.id==="empty")?undefined:"button"} tabIndex={viewOnly||section.id==="empty"||disabled?undefined:0}
              aria-label={section.id==="description"?"プレビューの説明を編集":(viewOnly||section.id==="empty")?undefined:products.find(p=>p.id===section.id)?.name+"をプレビューから編集"}
              onClick={()=>{if(disabled||viewOnly)return;if(section.id==="description")setEditing("description");else if(section.id!=="empty")onProduct(section.id);}}
              onKeyDown={event=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();event.currentTarget.click();}}}>
              <Markdown remarkPlugins={markdownPlugins} skipHtml components={{a:({children})=><span className="discord-preview-link">{children}</span>,img:()=>null}}>{previewMarkdown(section.text)}</Markdown>
            </div>)}
        </div>
        {embed.image&&<img className="discord-panel-image" src={embed.image.url} alt="自販機パネル画像"/>}
      </div>
      <div className="discord-panel-actions">{payload.components[0].components.map(button=><button type="button" key={button.custom_id} className={"discord-action style-"+button.style} aria-disabled="true" title="プレビューのため購入操作は行いません" onClick={()=>{}}>{button.emoji.name} {button.label}</button>)}</div>
    </div>
    <p className="muted">在庫・販売数は取得時点の値です。Discordの端末・テーマにより文字の折り返しなどは異なります。</p>
  </section>;
}
