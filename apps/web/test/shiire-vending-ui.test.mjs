import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

test('two sales categories can be edited independently and machine deletion requires confirmation',async t=>{
 const dir=await mkdtemp(path.resolve('.vending-ui-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 await build({entryPoints:['src/ShiireVendingManager.tsx'],bundle:true,platform:'node',format:'esm',packages:'external',outfile:path.join(dir,'Vending.mjs'),define:{'import.meta.env.VITE_API_BASE_URL':'"https://fixture.example"'},jsx:'automatic'});
 const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'https://fixture.example'});
 for(const key of ['window','document','navigator','HTMLElement','Element','Node','MutationObserver','localStorage','sessionStorage','location','getComputedStyle'])Object.defineProperty(globalThis,key,{value:key==='getComputedStyle'?dom.window.getComputedStyle.bind(dom.window):dom.window[key],configurable:true});
 globalThis.IS_REACT_ACT_ENVIRONMENT=true;t.after(()=>dom.window.close());
 const React=await import('react');const {render,screen,waitFor,cleanup,within,fireEvent}=await import('@testing-library/react');const {default:userEvent}=await import('@testing-library/user-event');t.after(cleanup);
 const {default:Vending}=await import(pathToFileURL(path.join(dir,'Vending.mjs')).href);
 const products=(machineId)=>[
  {id:machineId+'-normal',vending_machine_id:machineId,procurement_class:'NO_SHADOWBAN',supplier_product_id:'',name:'Search Top + No shadow ban',description:'Normal',price_paypay:150,price_kyash:150,stock_count:0,sales_count:0},
  {id:machineId+'-old',vending_machine_id:machineId,procurement_class:'TOP_SEARCH',supplier_product_id:'',name:'【old】Search Top + No shadow ban',description:'Old',price_paypay:500,price_kyash:500,stock_count:0,sales_count:0}
 ];
 const machine=(id,name)=>({id,guild_id:'fixture',name,panel_title:null,panel_description:null,panel_image_url:null,panel_color:5763719,products:products(id),panels:[],stockNotification:null});
 let machines=[machine('one','First machine'),machine('two','Second machine')],allowDelete=false;
 const writes=[],deletes=[],errors=[];globalThis.confirm=()=>allowDelete;
 const nativeFetch=globalThis.fetch;t.after(()=>{globalThis.fetch=nativeFetch;delete globalThis.confirm;});
 globalThis.fetch=async(input,init={})=>{
  const p=new URL(String(input)).pathname;
  if(p.endsWith('/status'))return Response.json({configured:true,installed:true,payment:{paypay:true,kyash:true},guild:{id:'fixture',name:'Fixture'}});
  if(p.endsWith('/source-products'))return Response.json({products:[]});
  if(p.endsWith('/orders'))return Response.json({orders:[]});
  if(p.endsWith('/vending')){
   if(init.method==='POST'){const created=machine('new',JSON.parse(init.body).name);machines.push(created);return Response.json(created,{status:201});}
   return Response.json(machines);
  }
  const update=p.match(/\/vending\/([^/]+)\/products\/([^/]+)$/);
  if(update&&init.method==='PATCH'){
   const payload=JSON.parse(init.body);writes.push(payload);const product=machines.find(m=>m.id===update[1]).products.find(p=>p.id===update[2]);Object.assign(product,{name:payload.name,description:payload.description,price_paypay:payload.pricePayPay,price_kyash:payload.priceKyash});return Response.json({ok:true});
  }
  const machineUpdate=p.match(/\/vending\/([^/]+)$/);
  if(machineUpdate&&init.method==='PATCH'){
   const payload=JSON.parse(init.body),row=machines.find(m=>m.id===machineUpdate[1]);
   Object.assign(row,{name:payload.name,panel_title:payload.panelTitle,panel_description:payload.panelDescription,panel_color:payload.panelColor});return Response.json({ok:true});
  }
  if(p.endsWith('/panel-image')&&init.method==='DELETE'){
   machines.find(m=>m.id===p.split('/').at(-2)).panel_image_url=null;return Response.json({ok:true});
  }
  if(init.method==='DELETE'){
   const id=p.split('/').at(-1);deletes.push(id);machines=machines.filter(m=>m.id!==id);return Response.json({ok:true,panelErrors:[]});
  }
  throw new Error('Unexpected request '+p);
 };
 const user=userEvent.setup();render(React.createElement(Vending,{guildId:'fixture',channels:[],roles:[],onNotice:()=>{},onError:e=>errors.push(e)}));
 await screen.findByRole('button',{name:'Search Top + No shadow banを編集'});
 assert.equal(screen.getByLabelText('販売所').value,'one');
 assert.equal(Boolean(screen.queryByRole('button',{name:'Second machine'})),false,'machine choices use one selector');
 for(const label of ['販売所を追加・削除','仕入れ元の詳しい情報','案内文・画像・購入後の設定','入荷通知を設定する','割引クーポンを設定する','設置済みメッセージの修復']) assert.equal(screen.getByText(label).parentElement.open,false,label+' is optional');
 await user.click(screen.getByText('販売所を追加・削除'));
 await user.click(screen.getByText('案内文・画像・購入後の設定'));
 await user.click(screen.getByText('商品を追加・詳しい情報を編集'));
 assert.equal(screen.getAllByRole('button',{name:'変更を保存して反映'}).length,1);
 await user.click(screen.getByRole('button',{name:'【old】Search Top + No shadow banを編集'}));
 assert.equal(screen.getByLabelText(/^PayPay価格/).value,'500');
 await user.clear(screen.getByLabelText(/^PayPay価格/));await user.type(screen.getByLabelText(/^PayPay価格/),'450');
 await user.click(screen.getByRole('button',{name:'変更を保存して反映'}));
 await waitFor(()=>assert.equal(writes.length,1));assert.equal(writes[0].procurementClass,'TOP_SEARCH');assert.equal(writes[0].pricePayPay,450);
 await waitFor(()=>assert.equal(screen.getByRole('button',{name:'Search Top + No shadow banを編集'}).disabled,false));
 await user.click(screen.getByRole('button',{name:'Search Top + No shadow banを編集'}));
 assert.equal(screen.getByLabelText(/^PayPay価格/).value,'150','editing Old must leave normal price alone');
 const preview=screen.getByTestId('discord-panel-preview');
 assert.equal(preview.querySelectorAll('img').length,0,'no image means no image slot or upload placeholder');
 assert.equal(within(preview).getByRole('button',{name:'🛒 購入する'}).getAttribute('aria-disabled'),'true');
 await user.click(screen.getByRole('button',{name:'プレビューのタイトルを編集'}));
 await user.type(screen.getByLabelText('プレビューのタイトル'),'開設キャンペーン');
 await user.click(screen.getByRole('button',{name:'プレビューの説明を編集'}));
 await user.type(screen.getByLabelText('プレビューの説明'),'**おすすめ**\n150円から販売');
 await user.click(screen.getByRole('button',{name:'【old】Search Top + No shadow banをプレビューから編集'}));
 await user.clear(screen.getByLabelText('プレビューの商品名'));await user.type(screen.getByLabelText('プレビューの商品名'),'Oldキャンペーン');
 assert.equal(screen.getByLabelText('プレビューの商品名').value,'Oldキャンペーン');
 await user.clear(screen.getByLabelText('プレビューのPayPay価格'));await user.type(screen.getByLabelText('プレビューのPayPay価格'),'470');
 await user.click(screen.getByRole('button',{name:'Search Top + No shadow banをプレビューから編集'}));
 await user.clear(screen.getByLabelText('プレビューのPayPay価格'));await user.type(screen.getByLabelText('プレビューのPayPay価格'),'160');
 await user.click(screen.getByRole('button',{name:'表示のみ'}));
 assert.match(preview.textContent,/PayPay: 160円/);assert.match(preview.textContent,/PayPay: 470円/);
 assert.deepEqual([...preview.querySelectorAll('code')].map(code=>code.textContent),['PayPay: 160円 / Kyash: 150円 / 在庫: 0 / 販売: 0','PayPay: 470円 / Kyash: 500円 / 在庫: 0 / 販売: 0']);
 assert.equal(preview.querySelector('pre'),null,'prices use inline code rather than a fenced code block');
 assert.equal(preview.querySelector('strong').textContent,'おすすめ');
 assert.equal(preview.querySelectorAll('input,textarea').length,0,'view-only has no editing controls');
 await user.click(screen.getByRole('button',{name:'スマホ'}));assert.ok(preview.classList.contains('is-mobile'));
 machines[0].panel_image_url='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCXsAAAAASUVORK5CYII=';
 fireEvent.change(screen.getByLabelText('パネルの色'),{target:{value:'#ff3366'}});
 assert.equal(screen.getByTestId('discord-panel-preview').querySelector('.discord-panel-embed').style.borderLeftColor,'rgb(255, 51, 102)');
 await user.click(screen.getByRole('button',{name:'変更を保存して反映'}));
 await waitFor(()=>assert.equal(writes.length,3));
 assert.equal(machines[0].panel_color,0xff3366);
 assert.equal(screen.getByLabelText('パネルの色').value,'#ff3366');
 await waitFor(()=>assert.equal(screen.getByRole('button',{name:'選択中の自販機を削除'}).disabled,false));
 assert.equal(machines[0].panel_title,'開設キャンペーン');assert.equal(machines[0].panel_description,'**おすすめ**\n150円から販売');
 assert.equal(machines[0].products[0].price_paypay,160);assert.equal(machines[0].products[1].price_paypay,470);
 assert.match(screen.getByTestId('discord-panel-preview').textContent,/PayPay: 470円/);
 assert.equal(screen.getByTestId('discord-panel-preview').querySelectorAll('img').length,1,'configured image is embedded exactly once');
 await user.clear(screen.getByLabelText('パネルタイトル'));await user.type(screen.getByLabelText('パネルタイトル'),'画像削除中の未保存タイトル');
 await user.click(screen.getByRole('button',{name:'パネル画像を削除'}));
 await waitFor(()=>assert.equal(screen.getByTestId('discord-panel-preview').querySelectorAll('img').length,0));
 assert.equal(screen.getByLabelText('パネルタイトル').value,'画像削除中の未保存タイトル','image removal must preserve text drafts');
 await user.click(screen.getByRole('button',{name:'選択中の自販機を削除'}));assert.equal(deletes.length,0);
 allowDelete=true;await user.click(screen.getByRole('button',{name:'選択中の自販機を削除'}));
 await waitFor(()=>assert.deepEqual(deletes,['one']));
 await waitFor(()=>assert.equal(screen.getByLabelText('自販機名').value,'Second machine'));
 await user.click(screen.getByRole('button',{name:'自販機を作成'}));
 await waitFor(()=>assert.equal(screen.getByLabelText('自販機名').value,'Xアカウント自販機','newly created machine should become selected'));
 assert.equal(screen.getByLabelText('パネルの色').value,'#57f287','new vending uses the original default color');
 assert.equal(screen.getAllByRole('button',{name:/Search Top \+ No shadow banを編集$/}).length,2);
 delete machines.find(machine=>machine.id==='new').panel_color;
 await user.click(screen.getByRole('button',{name:'再読み込み'}));
 await waitFor(()=>assert.equal(screen.getByLabelText('パネルの色').disabled,true));
 assert.ok(screen.getByText('色の変更には仕入れbotの最新版への更新・再起動が必要です。'));
 assert.deepEqual(errors,[]);
});
