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
  assert.match(source,/18:00入荷/);
  assert.match(source,/\/shiire\/daily-restock\/settings/);
  assert.match(source,/\/shiire\/daily-restock\/panel/);
  assert.match(source,/\/shiire\/daily-restock\/run/);
  assert.match(source,/No shadow ban 恒常在庫/);
  assert.match(source,/Top Search 恒常在庫/);
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
  assert.match(source,/在庫追加が実際に1個以上あった日だけDiscordへ通知/);
});
