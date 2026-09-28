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

test("member activity uses the integrated Security Gateway member feed", () => {
  assert.match(securityGatewaySource, /GUILD_MEMBER_ADD/);
  assert.match(securityGatewaySource, /GUILD_MEMBER_REMOVE/);
  assert.match(securityGatewaySource, /handleMemberActivityGatewayEvent/);
  assert.match(
    securityGatewaySource,
    /GATEWAY_INTENTS[\s\S]*GUILD_MEMBERS/
  );
  assert.doesNotMatch(gatewaySource, /payload\.t === "GUILD_MEMBER_ADD"/);
  assert.doesNotMatch(gatewaySource, /payload\.t === "GUILD_MEMBER_REMOVE"/);
  assert.match(gatewaySource, /GATEWAY_INTENTS\s*=\s*1 << 0/);
  assert.match(memberSource, /handleMemberActivityGatewayEvent/);
});

test("minute cron keeps the shared Discord Gateway alive without member polling", () => {
  const scheduled = indexSource.slice(indexSource.indexOf("async scheduled"));
  assert.doesNotMatch(scheduled, /memberActivitySweep\(env\)/);
  assert.match(scheduled, /ensureDiscordGateway\(env\)/);
  assert.match(gatewaySource, /discord-gateway\.internal\/start/);
  assert.doesNotMatch(gatewaySource, /enabled \? "start" : "stop"/);
});

test("fresh gateway sessions reconcile once before event-driven operation", () => {
  assert.match(gatewaySource, /await memberActivitySweep\(this\.env\)/);
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
