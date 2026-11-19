import type { Env } from "./types";
import { botJson } from "./discord";
import { getMachine, getStockNotify, getVmProduct } from "./vending-db";

/**
 * 在庫追加通知 of the product's machine. Used by the dashboard stock form and
 * by the procurement supply bridge (仕入れbotの補充), so arrivals are always
 * announced the same way. Failures never undo the stock change.
 */
export async function notifyStockAdded(env:Env,productId:string,count:number){
  if(count<=0) return false;
  const product=await getVmProduct(env,productId);
  if(!product) return false;
  const vm=await getMachine(env,product.vending_machine_id);
  if(!vm) return false;
  const notification=await getStockNotify(env,vm.id);
  if(!notification?.enabled||!notification.channel_id||!notification.role_id) return false;
  await botJson(env,"/channels/"+notification.channel_id+"/messages",{
    method:"POST",
    body:JSON.stringify({
      content:"<@&"+notification.role_id+">",
      allowed_mentions:{roles:[notification.role_id]},
      embeds:[{
        title:"在庫追加のお知らせ",
        color:5763719,
        description:"**"+product.name+"** の在庫が追加されました。",
        fields:[
          {name:"追加数",value:String(count)+"個",inline:true},
          {name:"自販機",value:vm.name,inline:true}
        ]
      }]
    })
  });
  return true;
}
