import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const memberSource = await readFile(
  new URL("../src/member-activity.ts", import.meta.url),
  "utf8"
);
const securityGatewaySource = await readFile(
  new URL("../src/security/gateway.ts", import.meta.url),
  "utf8"
);
const indexSource = await readFile(
  new URL("../src/index.ts", import.meta.url),
  "utf8"
);
const wranglerSource = await readFile(
  new URL("../wrangler.jsonc", import.meta.url),
  "utf8"
);

test("one unified Discord Gateway handles security and member activity", () => {
  assert.match(securityGatewaySource, /payload\.t === "GUILD_MEMBER_ADD"/);
  assert.match(securityGatewaySource, /payload\.t === "GUILD_MEMBER_REMOVE"/);
  assert.match(securityGatewaySource, /handleMemberActivityGatewayEvent/);
  assert.match(securityGatewaySource, /GUILD_MEMBERS/);
  assert.match(memberSource, /handleMemberActivityGatewayEvent/);
});

test("member activity shares the security Gateway instead of opening a second socket", () => {
  assert.doesNotMatch(indexSource, /ensureDiscordGateway/);
  assert.doesNotMatch(indexSource, /discordGatewayStatus/);
  assert.doesNotMatch(indexSource, /export \{ DiscordGateway \}/);
  assert.doesNotMatch(wranglerSource, /"name": "DISCORD_GATEWAY"/);
  assert.match(
    wranglerSource,
    /"deleted_classes": \["DiscordGateway"\]/
  );
});

test("unified Gateway performs member reconciliation independently", () => {
  assert.match(
    securityGatewaySource,
    /MEMBER_RECONCILE_INTERVAL_MS\s*=\s*60_000/
  );
  assert.match(securityGatewaySource, /lastMemberReconcileAt/);
  assert.match(securityGatewaySource, /unified gateway member reconcile failed/);
  assert.match(securityGatewaySource, /this\.state\.waitUntil/);
});

test("minute cron member fallback is isolated from Durable Object failures", () => {
  const scheduled = indexSource.slice(indexSource.indexOf("async scheduled"));
  assert.match(
    scheduled,
    /"memberActivitySweep scheduled task failed"[\s\S]*memberActivitySweep\(env\)/
  );
  assert.match(scheduled, /keepRunning/);
  assert.doesNotMatch(scheduled, /Promise\.all\(\[/);
  assert.doesNotMatch(scheduled, /ensureDiscordGateway\(env\)/);
});

test("normal Worker traffic self-starts only the unified security Gateway", () => {
  const fetchHandler = indexSource.slice(indexSource.indexOf("async fetch"));
  assert.match(fetchHandler, /ensureDiscordSecurityGateway\(env\)/);
  assert.doesNotMatch(fetchHandler, /ensureDiscordGateway\(env\)/);
});

test("health identifies the Free-tier single-Gateway architecture", () => {
  assert.match(indexSource, /unifiedGatewayStatus\(env\)/);
  assert.match(indexSource, /single-gateway-free-tier-v3/);
  assert.match(
    indexSource,
    /unified-gateway-plus-isolated-cron-reconcile/
  );
});
