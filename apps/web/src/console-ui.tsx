// Shared pieces for the sidebar console screens.

export type ConsoleChannel = {
  id:string;
  name:string;
  type?:string;
  botCanPost?:boolean;
};

export type VmMachine = {
  id:string;
  name:string;
  panel_title:string|null;
  panel_color:string|null;
};

export type VmProduct = {
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

export type VmCoupon = { code:string; discount:number; created_at:number };

export type VmDetail = VmMachine & { products:VmProduct[]; coupons:VmCoupon[] };

export type VmPanelRow = {
  id:string;
  channelId:string|null;
  messageId:string|null;
};

export type ShiireProductRow = {
  id:string;
  name:string;
  description?:string;
  price_paypay:number;
  price_kyash:number;
  emoji:string|null;
  stockless_enabled:number;
  sales_count:number;
  stock_count:number;
};

export type ShiireMachineRow = {
  id:string;
  name:string;
  active:number;
  products?:ShiireProductRow[];
  panels?:Array<{channel_id:string;message_id:string}>;
};

/** Channels a panel can be posted to. */
export function postableChannels(channels:ConsoleChannel[]){
  return channels.filter(channel=>
    (channel.type===undefined||channel.type==="text"||channel.type==="announcement")
  );
}

export function channelName(channels:ConsoleChannel[],id:string|null|undefined){
  if(!id) return null;
  const channel=channels.find(row=>row.id===id);
  return channel?channel.name:id;
}

export function yen(value:number){
  return "¥"+Math.round(value).toLocaleString("ja-JP");
}

export function errorText(reason:unknown){
  return reason instanceof Error?reason.message:String(reason);
}

const paths:Record<string,string> = {
  grid:"M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
  machine:"M6 10V8a6 6 0 0 1 12 0v2M4 10h16v10H4zM9 15h6",
  list:"M4 6h16M4 12h10M4 18h16",
  box:"M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5",
  ticket:"M4 7h16v3a2 2 0 0 0 0 4v3H4v-3a2 2 0 0 0 0-4zM10 7v10",
  tag:"M3 12l9-9h8v8l-9 9zM15.5 8.5h.01",
  card:"M3 6h18v12H3zM3 10h18M7 15h4",
  image:"M4 4h16v16H4zM4 16l5-5 4 4 3-3 4 4M15 9h.01",
  panels:"M4 5h16v6H4zM4 15h7v4H4zM15 15h5v4h-5z",
  gear:"M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1-2 2-.1-.1a1.6 1.6 0 0 0-2.7 1.1V20h-2.8v-.1a1.6 1.6 0 0 0-2.7-1.1l-.1.1-2-2 .1-.1A1.6 1.6 0 0 0 4.6 15H4v-2.8h.1a1.6 1.6 0 0 0 1.1-2.7l-.1-.1 2-2 .1.1A1.6 1.6 0 0 0 10 6.4V6h2.8v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1 2 2-.1.1a1.6 1.6 0 0 0 1.1 2.7h.4V15z",
  shield:"M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z",
  door:"M5 21V4h10v17M15 6h4v15M11 12h.01",
  check:"M4 12l5 5L20 6",
  backup:"M4 7c0-2 3.6-3 8-3s8 1 8 3-3.6 3-8 3-8-1-8-3zM4 7v10c0 2 3.6 3 8 3s8-1 8-3V7M4 12c0 2 3.6 3 8 3s8-1 8-3",
  truck:"M3 6h11v10H3zM14 10h4l3 3v3h-7M7 19a2 2 0 1 0 0-.01M17 19a2 2 0 1 0 0-.01",
  link:"M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  users:"M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21a7 7 0 0 1 14 0M17 3a4 4 0 0 1 0 8M22 21a7 7 0 0 0-4-6.3",
  wrench:"M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.5-2.5z",
  spark:"M12 2v6M12 16v6M2 12h6M16 12h6M5 5l4 4M15 15l4 4M19 5l-4 4M9 15l-4 4",
  refresh:"M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4",
  logout:"M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11",
  plus:"M12 5v14M5 12h14",
  bolt:"M13 2L4 14h7l-1 8 9-12h-7z",
  menu:"M4 6h16M4 12h16M4 18h16",
  coins:"M12 4c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3zM4 7v5c0 1.7 3.6 3 8 3s8-1.3 8-3V7M4 12v5c0 1.7 3.6 3 8 3s8-1.3 8-3v-5"
};

export function Icon({name,size=20}:{name:keyof typeof paths|string;size?:number}){
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[name]??paths.grid} />
    </svg>
  );
}
