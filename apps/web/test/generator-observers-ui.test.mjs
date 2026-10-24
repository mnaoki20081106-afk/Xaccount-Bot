import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const ui = readFileSync(new URL("../src/XGeneratorManager.tsx", import.meta.url), "utf8");
const bridge = readFileSync(new URL("../../worker/src/generator-bridge.ts", import.meta.url), "utf8");

test("卒業テストタブから観測者のauth_token/ct0を登録できる", () => {
  assert.match(ui, /key: "graduation", label: "卒業テスト"/);
  assert.match(ui, /base \+ "\/observers"/);
  assert.match(ui, /type="password" value=\{obsAuthToken\}/);
  assert.match(ui, /type="password" value=\{obsCt0\}/);
});

test("トークンは入力後にクリアされ、一覧型にはトークン項目がない", () => {
  assert.match(ui, /setObsAuthToken\(""\)/);
  assert.match(ui, /setObsCt0\(""\)/);
  const rowType = ui.match(/type ObserverRow = \{[\s\S]*?\};/)[0];
  assert.doesNotMatch(rowType, /auth_token|ct0/);
});

test("workerは観測者の登録・検証・削除と卒業状況をGenerator署名付きで中継する", () => {
  for (const p of ["/api/generator/observers", "/api/generator/graduation"]) {
    assert.ok(bridge.includes(p), p);
  }
  assert.match(bridge, /OBSERVER_CREDENTIAL_INVALID/);
  assert.match(bridge, /\/observers\\\/\(\\d\{1,9\}\)\(\\\/verify\)\?\$/);
});
