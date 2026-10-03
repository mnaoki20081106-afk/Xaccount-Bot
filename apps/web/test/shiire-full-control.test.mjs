import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const source=readFileSync(
  new URL("../src/ShiireOperationsCenter.tsx",import.meta.url),
  "utf8"
);

test("main dashboard exposes procurement budget controls",()=>{
  assert.match(source,/仕入れ資金の配分/);
  assert.match(source,/\/shiire\/procurement-budget/);
  assert.match(source,/inviteCampaignPercent/);
  assert.match(source,/noShadowbanPercent/);
  assert.match(source,/topSearchPercent/);
});

test("main dashboard exposes daily 18:00 restock controls",()=>{
  assert.match(source,/毎日18:00に不足分を補充/);
  assert.match(source,/daily-restock\/settings/);
  assert.match(source,/\/shiire\/daily-restock\/panel/);
  assert.match(source,/\/shiire\/daily-restock\/run/);
  assert.match(source,/シャドウバンなしの在庫目標/);
  assert.match(source,/検索上位の在庫目標/);
});

test("main dashboard exposes invite campaign controls",()=>{
  assert.match(source,/招待キャンペーン設定/);
  assert.match(source,/\/shiire\/invite-campaign\/settings/);
  assert.match(source,/\/shiire\/invite-campaign\/seed/);
  assert.match(source,/invite-campaign\/rewards/);
});

test("main dashboard exposes editable procurement policy and safety controls",()=>{
  assert.match(source,/仕入れ条件を保存/);
  assert.match(source,/\/shiire\/procurement-settings/);
  assert.match(source,/seller_quality_mode/);
  assert.match(source,/approved_hstora_product_ids/);
  assert.match(source,/require_bulk_confirmation/);
  assert.match(source,/max_price_jump_percent/);
});

test("main dashboard wording reflects minute funding detection and 18:00 ordinary restock",()=>{
  assert.match(source,/入金反映は1分ごとに検知/);
  assert.match(source,/通常在庫は18:00/);
  assert.match(source,/18時の入荷まとめ通知/);
});


const vendingSource=readFileSync(
  new URL("../src/ShiireVendingManager.tsx",import.meta.url),
  "utf8"
);

test("legacy vending screen no longer owns a second procurement settings form",()=>{
  assert.doesNotMatch(vendingSource,/async function saveProcurementSettings/);
  assert.match(vendingSource,/仕入れの予算・在庫目標は「仕入れ設定」で変更/);
});


test("vending editor presets the requested sales names descriptions and prices",()=>{
  assert.match(vendingSource,/Search Top \+ No shadow ban/);
  assert.match(vendingSource,/検索上位に載るシャドバンされてない垢です。/);
  assert.match(vendingSource,/price:350/);
  assert.match(vendingSource,/【old】Search Top \+ No shadow ban/);
  assert.match(vendingSource,/検索上位にのるシャドバンされていないOld垢です。より運用向きです！/);
  assert.match(vendingSource,/price:500/);
});


test("vending price edits can repost existing Discord panels",()=>{
  assert.match(vendingSource,/設置済みメッセージの修復/);
  assert.match(vendingSource,/既設パネルを削除して再設置/);
  assert.match(vendingSource,/repostPanels:true/);
  assert.match(vendingSource,/\/panel\/repost/);
});
