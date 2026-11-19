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

test("the affiliate tab exposes invite campaign and free giveaway controls, with a shared-stock product picker",()=>{
  const affiliateSource=readFileSync(
    new URL("../src/AffiliateManager.tsx",import.meta.url),
    "utf8"
  );
  assert.match(affiliateSource,/招待キャンペーン/);
  assert.match(affiliateSource,/\/invite-campaign\/settings/);
  assert.match(affiliateSource,/\/invite-campaign\/seed/);
  assert.match(affiliateSource,/invite-campaign\/rewards/);
  assert.match(affiliateSource,/無料配布/);
  assert.match(affiliateSource,/\/free-giveaway\/settings/);
  assert.match(affiliateSource,/\/free-giveaway\/blocklist/);
  assert.match(affiliateSource,/\/free-giveaway\/panel/);
  assert.match(affiliateSource,/\/affiliate\/" \+ kind \+ "\/product/);
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
