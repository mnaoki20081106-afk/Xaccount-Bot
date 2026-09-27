import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("integrated security is bound locally", () => {
  const wrangler = fs.readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const bridge = fs.readFileSync(new URL("../src/security-bridge.ts", import.meta.url), "utf8");
  const index = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(wrangler, /SECURITY_GATEWAY/);
  assert.match(wrangler, /DiscordSecurityGateway/);
  assert.doesNotMatch(wrangler, /SECURITY_SERVICE/);
  assert.match(bridge, /handleIntegratedSecurityRequest/);
  assert.match(index, /runIntegratedSecurityScheduled/);
  assert.match(index, /export \{ DiscordSecurityGateway \}/);
});
