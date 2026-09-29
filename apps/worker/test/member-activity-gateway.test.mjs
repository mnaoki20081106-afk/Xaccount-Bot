// CI probe: final event-driven member tracking.
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

test("normal member tracking is purely event-driven", () => {
  assert.doesNotMatch(securityGatewaySource, /MEMBER_RECONCILE_INTERVAL_MS/);
  assert.doesNotMatch(securityGatewaySource, /memberActivitySweep/);

  const scheduled = indexSource.slice(indexSource.indexOf("async scheduled"));
  assert.doesNotMatch(scheduled, /memberActivitySweep/);
  assert.doesNotMatch(scheduled, /recoverMemberActivityAfterFreshSession/);

  assert.match(
    securityGatewaySource,
    /handleMemberActivityGatewayEvent\(this\.env, "join", event\)/
  );
  assert.match(
    securityGatewaySource,
    /handleMemberActivityGatewayEvent\(this\.env, "leave", event\)/
  );
});

test("fresh non-resumable sessions recover automatically once", () => {
  const readyBlock = securityGatewaySource.slice(
    securityGatewaySource.indexOf('payload.t === "READY"'),
    securityGatewaySource.indexOf('payload.t === "RESUMED"')
  );
  assert.match(readyBlock, /recoverMemberActivityAfterFreshSession/);
  assert.match(readyBlock, /this\.state\.waitUntil/);

  const resumedBlock = securityGatewaySource.slice(
    securityGatewaySource.indexOf('payload.t === "RESUMED"'),
    securityGatewaySource.indexOf('payload.t === "GUILD_CREATE"')
  );
  assert.doesNotMatch(resumedBlock, /recoverMemberActivityAfterFreshSession/);
});

test("fresh-session recovery writes only snapshot differences", () => {
  assert.match(memberSource, /function snapshotChanged/);
  assert.match(memberSource, /async function persistSnapshotDiff/);
  assert.match(memberSource, /const joined = members\.filter/);
  assert.match(memberSource, /const left = previous\.filter/);
  assert.match(memberSource, /const changed = members\.filter/);
  assert.doesNotMatch(
    memberSource,
    /DELETE FROM member_activity_members WHERE guild_id=\? AND last_seen_at</
  );
});

test("normal Worker traffic self-starts only the unified security Gateway", () => {
  const fetchHandler = indexSource.slice(indexSource.indexOf("async fetch"));
  assert.match(fetchHandler, /ensureDiscordSecurityGateway\(env\)/);
  assert.doesNotMatch(fetchHandler, /ensureDiscordGateway\(env\)/);
});

test("health identifies automatic event-driven recovery", () => {
  assert.match(indexSource, /unifiedGatewayStatus\(env\)/);
  assert.match(indexSource, /event-driven-member-activity-v4/);
  assert.match(
    indexSource,
    /gateway-events-plus-automatic-fresh-session-diff/
  );
});
