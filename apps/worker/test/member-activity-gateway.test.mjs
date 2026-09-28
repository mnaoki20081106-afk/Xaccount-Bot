import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const gatewaySource = await readFile(
  new URL("../src/discord-gateway.ts", import.meta.url),
  "utf8"
);
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

test("member activity uses its dedicated GUILDS + GUILD_MEMBERS gateway", () => {
  assert.match(gatewaySource, /payload\.t === "GUILD_MEMBER_ADD"/);
  assert.match(gatewaySource, /payload\.t === "GUILD_MEMBER_REMOVE"/);
  assert.match(gatewaySource, /handleMemberActivityGatewayEvent/);
  assert.match(
    gatewaySource,
    /GATEWAY_INTENTS\s*=\s*\(1 << 0\) \| \(1 << 1\)/
  );
  assert.match(memberSource, /handleMemberActivityGatewayEvent/);
});

test("security gateway cannot become a dependency of member activity", () => {
  assert.match(securityGatewaySource, /GUILD_MEMBER_ADD/);
  assert.doesNotMatch(securityGatewaySource, /GUILD_MEMBER_REMOVE/);
  assert.doesNotMatch(securityGatewaySource, /handleMemberActivityGatewayEvent/);
  assert.doesNotMatch(securityGatewaySource, /GatewayMemberActivityEvent/);
});

test("minute cron keeps the Gateway alive and reconciles missed member events", () => {
  const scheduled = indexSource.slice(indexSource.indexOf("async scheduled"));
  assert.match(scheduled, /memberActivitySweep\(env\)/);
  assert.match(scheduled, /ensureDiscordGateway\(env\)/);
  assert.match(gatewaySource, /discord-gateway\.internal\/start/);
  assert.doesNotMatch(gatewaySource, /enabled \? "start" : "stop"/);
});

test("member gateway reconciles independently of Worker cron", () => {
  assert.match(gatewaySource, /MEMBER_RECONCILE_INTERVAL_MS\s*=\s*60_000/);
  assert.match(gatewaySource, /lastReconcileAt/);
  assert.match(gatewaySource, /member activity durable reconcile failed/);
  assert.match(gatewaySource, /this\.state\.waitUntil/);
});

test("normal Worker traffic self-starts the member gateway", () => {
  const fetchHandler = indexSource.slice(indexSource.indexOf("async fetch"));
  assert.match(fetchHandler, /ensureDiscordGateway\(env\)/);
  assert.match(fetchHandler, /member activity gateway start failed/);
});

test("health exposes dedicated member gateway diagnostics", () => {
  assert.match(gatewaySource, /discord-gateway\.internal\/status/);
  assert.match(indexSource, /discordGatewayStatus\(env\)/);
  assert.match(indexSource, /member-activity-isolated-v2/);
  assert.match(indexSource, /dedicated-gateway-plus-do-reconcile/);
});

test("gateway guild events maintain the dashboard guild cache", () => {
  assert.match(gatewaySource, /payload\.t === "GUILD_CREATE"/);
  assert.match(gatewaySource, /upsertBotGuildCache/);
  assert.match(gatewaySource, /payload\.t === "GUILD_DELETE"/);
  assert.match(gatewaySource, /deleteBotGuildCache/);
  assert.match(gatewaySource, /!guild\.unavailable/);
});

test("fresh READY seeds all guild IDs for the dashboard", () => {
  assert.match(gatewaySource, /ready\.guilds/);
  assert.match(gatewaySource, /replaceBotGuildMembership/);
  assert.match(gatewaySource, /GUILD_MEMBERSHIP_SEED_KEY/);
  assert.match(gatewaySource, /seed guild membership/);
});
