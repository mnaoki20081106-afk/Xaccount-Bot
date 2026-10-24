import test from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare} from 'miniflare';

const guildId = '123456789012345678';
const botId = '423456789012345678';
const generatorSecret = 'generator-secret-longer-than-32-characters';
const shiireSecret = 'shiire-secret-longer-than-32-characters-x';

async function runtime(t) {
  const state = {
    generatorCalls: 0,
    generatorRequests: [],
    generatorStubs: {},
    generatorPops: [],
    generatorOutOfStock: false,
    shiireStock: 0,
    shiireClass: undefined,
    pools: {'invite-campaign': 0, 'free-giveaway': 0},
    poolAdds: [],
    shiireAdds: [],
    shiireFailAdd: false,
    nextAccount: 1
  };
  const mf = new Miniflare({
    modules: true,
    scriptPath: '.test-worker/index.js',
    compatibilityDate: '2026-08-06',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'],
    bindings: {
      DISCORD_BOT_TOKEN: 'local-test-token', DISCORD_APPLICATION_ID: botId,
      DISCORD_PUBLIC_KEY: '00'.repeat(32),
      DASHBOARD_PASSWORD: 'local-test-password',
      SESSION_ENCRYPTION_KEY: 'local-test-key-not-for-production',
      WEB_ORIGIN: 'https://dashboard.example', WEB_PUBLIC_URL: 'https://dashboard.example/',
      GENERATOR_API_BASE_URL: 'https://generator.example', GENERATOR_BRIDGE_SECRET: generatorSecret,
      SHIIRE_API_BASE_URL: 'https://shiire.example', SHIIRE_BRIDGE_SECRET: shiireSecret
    },
    outboundService: async request => {
      const url = new URL(request.url);
      if (url.hostname === 'generator.example') {
        state.generatorCalls++;
        assert.ok(request.headers.get('X-Generator-Signature'), 'generator calls must be signed');
        if (url.pathname !== '/api/generator/pop') {
          const text = await request.text();
          state.generatorRequests.push({method: request.method, path: url.pathname, search: url.search, body: text});
          const stub = state.generatorStubs[request.method + ' ' + url.pathname];
          if (stub) return Response.json(stub.body, {status: stub.status});
          return Response.json({ok: true, path: url.pathname});
        }
        const body = await request.json();
        state.generatorPops.push(body);
        if (state.generatorOutOfStock) return Response.json({detail: 'OUT_OF_STOCK'}, {status: 409});
        const accounts = Array.from({length: body.count}, () => {
          const n = state.nextAccount++;
          return {id: n, username: 'user' + n, password: 'pw' + n, email: 'user' + n + '@mail.test',
            phone: null, auth_token: 'tok' + n, ct0: null, twofa_secret: null};
        });
        return Response.json({ok: true, popped: accounts.length, accounts});
      }
      if (url.hostname === 'shiire.example') {
        assert.ok(request.headers.get('X-Shiire-Signature'), 'shiire calls must be signed');
        const base = '/bridge/main/guilds/' + guildId;
        if (url.pathname === base + '/vending' && request.method === 'GET') {
          return Response.json([{id: 'sm1', name: 'Shiire machine', products: [
            {id: 'sp1', name: 'Shiire product', procurement_class: state.shiireClass ?? 'NO_SHADOWBAN', stock_count: state.shiireStock}
          ]}]);
        }
        if (url.pathname === base + '/generator/products/sp1/stock') {
          if (request.method === 'GET') return Response.json({productId: 'sp1', name: 'Shiire product', stockCount: state.shiireStock});
          const body = await request.json();
          if (state.shiireFailAdd) return Response.json({message: 'fixture failure'}, {status: 500});
          state.shiireAdds.push(body.items);
          state.shiireStock += body.items.length;
          return Response.json({ok: true, submitted: body.items.length, added: body.items.length, stockCount: state.shiireStock});
        }
        const poolMatch = url.pathname.match(new RegExp('^' + base + '/generator/pools/([^/]+)/stock$'));
        if (poolMatch && Object.hasOwn(state.pools, poolMatch[1])) {
          const pool = poolMatch[1];
          if (request.method === 'GET') return Response.json({pool, stockCount: state.pools[pool]});
          const body = await request.json();
          if (state.shiireFailAdd) return Response.json({message: 'fixture failure'}, {status: 500});
          state.poolAdds.push({pool, items: body.items});
          state.pools[pool] += body.items.length;
          return Response.json({ok: true, submitted: body.items.length, added: body.items.length, stockCount: state.pools[pool]});
        }
        return Response.json({message: 'NOT_FOUND'}, {status: 404});
      }
      assert.equal(url.hostname, 'discord.com', 'tests must never contact anything else');
      if (url.pathname === '/api/v10/guilds/' + guildId) return Response.json({id: guildId, name: 'Fixture guild'});
      if (url.pathname.endsWith('/users/@me')) return Response.json({id: botId, username: 'Test bot'});
      return Response.json([]);
    }
  });
  t.after(() => mf.dispose());
  const login = await (await mf.dispatchFetch('https://worker.example/api/login', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({password: 'local-test-password'})
  })).json();
  const call = async (path, method = 'GET', body) => {
    const response = await mf.dispatchFetch('https://worker.example' + path, {
      method,
      headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + login.token},
      ...(body === undefined ? {} : {body: JSON.stringify(body)})
    });
    return {status: response.status, body: await response.json()};
  };
  const sweep = async () => {
    const worker = await mf.getWorker();
    const result = await worker.scheduled({cron: '* * * * *'});
    assert.equal(result.outcome, 'ok');
    // scheduled tasks run via waitUntil; give them time to settle.
    await new Promise(resolve => setTimeout(resolve, 600));
  };
  return {mf, state, call, sweep};
}

async function seedVending(call) {
  const machine = (await call(`/api/guilds/${guildId}/vending`, 'POST', {name: 'Restock machine'})).body;
  const product = (await call(`/api/guilds/${guildId}/vending/${machine.id}/products`, 'POST', {
    name: 'Account', description: '', pricePayPay: 100, priceKyash: 100, emoji: null, infiniteStock: false
  })).body;
  return {machine, product};
}

const rulesPath = `/api/guilds/${guildId}/generator/restock-rules`;

test('vending product is topped up from the generator only when below the minimum', async t => {
  const {state, call, sweep} = await runtime(t);
  const {machine, product} = await seedVending(call);
  const stockOf = async () => (await call(`/api/guilds/${guildId}/vending/${machine.id}`)).body.products.find(p => p.id === product.id).stock_count;

  const created = await call(rulesPath, 'POST', {
    targetSystem: 'vending', vendingMachineId: machine.id, productId: product.id,
    minStock: 3, targetStock: 5, maxBatch: 4
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.machineName, 'Restock machine');
  assert.equal(created.body.productName, 'Account');

  await sweep();
  assert.equal(await stockOf(), 4, 'empty stock is filled by min(target - stock, maxBatch)');
  assert.equal(state.generatorPops.length, 1);
  assert.deepEqual(state.generatorPops[0], {count: 4, min_warmup_days: 0, allow_soft_shadow: false, tier: 'any'});

  await sweep();
  assert.equal(state.generatorPops.length, 1, 'stock at or above the minimum must not pop more accounts');

  const withdrawn = await call(`/api/guilds/${guildId}/vending/${machine.id}/products/${product.id}/withdraw`, 'POST', {quantity: 3});
  assert.equal(withdrawn.status, 200, JSON.stringify(withdrawn.body));
  assert.equal(await stockOf(), 1);
  await sweep();
  assert.equal(await stockOf(), 5, 'refill aims for the target stock');
  assert.equal(state.generatorPops.length, 2);
  assert.equal(state.generatorPops[1].count, 4);

  const listed = (await call(rulesPath)).body;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].lastAdded, 4);
  assert.equal(listed[0].lastError, null);
});

test('rule validation rejects infinite stock, duplicates and bad policies', async t => {
  const {call} = await runtime(t);
  const {machine, product} = await seedVending(call);
  const infinite = (await call(`/api/guilds/${guildId}/vending/${machine.id}/products`, 'POST', {
    name: 'Infinite', description: '', pricePayPay: 1, priceKyash: 1, emoji: null, infiniteStock: true, infiniteContent: 'x'
  })).body;
  const base = {targetSystem: 'vending', vendingMachineId: machine.id, minStock: 1, targetStock: 3, maxBatch: 2};

  assert.equal((await call(rulesPath, 'POST', {...base, productId: infinite.id})).status, 400);
  assert.equal((await call(rulesPath, 'POST', {...base, productId: 'missing'})).status, 404);
  assert.equal((await call(rulesPath, 'POST', {...base, productId: product.id, targetStock: 0})).status, 400);
  assert.equal((await call(rulesPath, 'POST', {...base, productId: product.id, maxBatch: 0})).status, 400);
  assert.equal((await call(rulesPath, 'POST', {...base, productId: product.id})).status, 201);
  assert.equal((await call(rulesPath, 'POST', {...base, productId: product.id})).status, 409);
});

test('requests without a dashboard session are refused', async t => {
  const {mf} = await runtime(t);
  const response = await mf.dispatchFetch('https://worker.example' + rulesPath);
  assert.equal(response.status, 401);
});

test('generator running out of stock is reported on the rule without adding anything', async t => {
  const {state, call, sweep} = await runtime(t);
  const {machine, product} = await seedVending(call);
  state.generatorOutOfStock = true;
  await call(rulesPath, 'POST', {targetSystem: 'vending', vendingMachineId: machine.id, productId: product.id, minStock: 2, targetStock: 4, maxBatch: 4});
  await sweep();
  const rule = (await call(rulesPath)).body[0];
  assert.match(rule.lastError, /OUT_OF_STOCK/);
  assert.equal(rule.pendingDelivery, false);
  const stock = (await call(`/api/guilds/${guildId}/vending/${machine.id}`)).body.products[0].stock_count;
  assert.equal(stock, 0);
});

test('仕入れBot product is restocked through the signed bridge and survives a failed delivery', async t => {
  const {state, call, sweep} = await runtime(t);

  const created = await call(rulesPath, 'POST', {
    targetSystem: 'shiire', vendingMachineId: 'sm1', productId: 'sp1',
    minStock: 2, targetStock: 4, maxBatch: 3, minWarmupDays: 2
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.machineName, 'Shiire machine');
  assert.equal(created.body.productName, 'Shiire product');
  assert.equal((await call(rulesPath, 'POST', {targetSystem: 'shiire', vendingMachineId: 'sm1', productId: 'nope', minStock: 1, targetStock: 2, maxBatch: 1})).status, 404);

  // Delivery to the Shiire bridge fails after the generator already handed the accounts over.
  state.shiireFailAdd = true;
  const failed = await call(rulesPath + '/' + created.body.id + '/run-now', 'POST');
  assert.equal(failed.status, 502);
  assert.equal(state.generatorPops.length, 1);
  assert.deepEqual(state.generatorPops[0], {count: 3, min_warmup_days: 2, allow_soft_shadow: false, tier: 'any'});
  let rule = (await call(rulesPath)).body[0];
  assert.equal(rule.pendingDelivery, true, 'popped accounts are kept for retry');
  assert.match(rule.lastError, /SHIIRE_API_ERROR/);
  assert.equal((await call(rulesPath + '/' + rule.id, 'DELETE')).status, 409, 'a rule holding undelivered accounts cannot be deleted');

  // Once the bridge works again the sweep delivers the same accounts and pops nothing new.
  state.shiireFailAdd = false;
  await sweep();
  assert.equal(state.generatorPops.length, 1, 'pending accounts are delivered before anything else is popped');
  assert.equal(state.shiireAdds.length, 1);
  assert.equal(state.shiireAdds[0].length, 3);
  assert.equal(state.shiireAdds[0][0], "user1:pw1:user1@mail.test::::::tok1");
  assert.equal(state.shiireStock, 3);
  rule = (await call(rulesPath)).body[0];
  assert.equal(rule.pendingDelivery, false);
  assert.equal(rule.lastError, null);

  // Stock 3 >= minimum 2: nothing more happens.
  await sweep();
  assert.equal(state.generatorPops.length, 1);
  assert.equal((await call(rulesPath + '/' + rule.id, 'DELETE')).status, 200);
});

test('every generator route requires a dashboard session and never reaches the generator without one', async t => {
  const {mf, state, call} = await runtime(t);
  const base = `https://worker.example/api/guilds/${guildId}/generator`;
  const routes = [
    ['GET', '/status'], ['GET', '/inventory'], ['GET', '/accounts'], ['GET', '/config'],
    ['POST', '/generate'], ['POST', '/push-to-shiire'], ['GET', '/restock-rules'],
    ['GET', '/proxy'], ['POST', '/proxy/health-check'], ['POST', '/proxy/sessions/abc123/reset'],
    ['DELETE', '/proxy/sessions/abc123'], ['GET', '/server'],
    ['GET', '/assign'], ['POST', '/assign'], ['GET', '/costs'], ['GET', '/expenses'], ['POST', '/expenses'], ['DELETE', '/expenses/1'],
    ['GET', '/vps-contract'], ['PUT', '/vps-contract'], ['GET', '/logs'], ['POST', '/generate/stop']
  ];
  for (const [method, path] of routes) {
    const body = method === 'POST' ? JSON.stringify({count: 1, supplierId: 's', sku: 'k'}) : undefined;
    const anonymous = await mf.dispatchFetch(base + path, {method, body, headers: {'Content-Type': 'application/json'}});
    assert.equal(anonymous.status, 401, method + ' ' + path + ' must refuse requests without a session');
    const forged = await mf.dispatchFetch(base + path, {method, body, headers: {'Content-Type': 'application/json', Authorization: 'Bearer not-a-real-token'}});
    assert.equal(forged.status, 401, method + ' ' + path + ' must refuse an unknown token');
  }
  assert.equal(state.generatorCalls, 0, 'no unauthenticated request may reach the generator');
  // With a session the same proxy routes work.
  const status = await call(`/api/guilds/${guildId}/generator/status`);
  assert.equal(status.status, 200);
  assert.equal(state.generatorCalls, 1);
});

test('proxy and server routes are forwarded with the right method, path and body', async t => {
  const {state, call} = await runtime(t);
  const base = `/api/guilds/${guildId}/generator`;

  assert.equal((await call(base + '/proxy')).body.path, '/api/generator/proxy');
  assert.equal((await call(base + '/server')).body.path, '/api/generator/server');
  assert.equal((await call(base + '/proxy/health-check', 'POST')).status, 200);
  assert.equal((await call(base + '/proxy/sessions/abc123/reset', 'POST', {circuit: false, cooldown: true})).status, 200);
  assert.equal((await call(base + '/proxy/sessions/abc123', 'DELETE')).status, 200);

  assert.deepEqual(state.generatorRequests.map(r => r.method + ' ' + r.path), [
    'GET /api/generator/proxy',
    'GET /api/generator/server',
    'POST /api/generator/proxy/health-check',
    'POST /api/generator/proxy/sessions/abc123/reset',
    'DELETE /api/generator/proxy/sessions/abc123'
  ]);
  assert.deepEqual(JSON.parse(state.generatorRequests[3].body), {circuit: false, cooldown: true});
});

test('proxy session ids are validated before anything reaches the generator', async t => {
  const {state, call} = await runtime(t);
  const base = `/api/guilds/${guildId}/generator`;
  for (const id of ['bad.id', 'a'.repeat(65), 'x%2Fy']) {
    assert.equal((await call(base + '/proxy/sessions/' + id, 'DELETE')).status, 400, id);
    assert.equal((await call(base + '/proxy/sessions/' + id + '/reset', 'POST', {circuit: true})).status, 400, id);
  }
  assert.equal(state.generatorRequests.length, 0);
});

test('generator refusals reach the dashboard, but a rejected signature does not look like a logout', async t => {
  const {state, call} = await runtime(t);
  const base = `/api/guilds/${guildId}/generator`;
  state.generatorStubs['DELETE /api/generator/proxy/sessions/busy01'] = {status: 409, body: {detail: 'SESSION_IN_USE'}};
  state.generatorStubs['GET /api/generator/proxy'] = {status: 401, body: {detail: 'INVALID_SIGNATURE'}};

  const busy = await call(base + '/proxy/sessions/busy01', 'DELETE');
  assert.equal(busy.status, 409);
  assert.match(busy.body.error, /SESSION_IN_USE/);

  const rejected = await call(base + '/proxy');
  assert.equal(rejected.status, 502, 'upstream 401 must not be forwarded as 401');
  assert.match(rejected.body.error, /INVALID_SIGNATURE/);
});

test('cost, ledger, contract, log and stop routes are forwarded; ids and log queries are validated', async t => {
  const {state, call} = await runtime(t);
  const base = `/api/guilds/${guildId}/generator`;

  assert.equal((await call(base + '/costs')).body.path, '/api/generator/costs');
  assert.equal((await call(base + '/expenses')).body.path, '/api/generator/expenses');
  const expense = {category: 'proxy', amount: 20, currency: 'USD', rate_to_jpy: 150, quantity: 10};
  assert.equal((await call(base + '/expenses', 'POST', expense)).status, 200);
  assert.equal((await call(base + '/expenses/42', 'DELETE')).status, 200);
  assert.equal((await call(base + '/vps-contract')).body.path, '/api/generator/vps-contract');
  assert.equal((await call(base + '/vps-contract', 'PUT', {monthly_fee_jpy: 3000})).status, 200);
  assert.equal((await call(base + '/logs?lines=50&level=error&evil=1')).status, 200);
  assert.equal((await call(base + '/generate/stop', 'POST')).status, 200);

  assert.deepEqual(state.generatorRequests.map(r => r.method + ' ' + r.path), [
    'GET /api/generator/costs',
    'GET /api/generator/expenses',
    'POST /api/generator/expenses',
    'DELETE /api/generator/expenses/42',
    'GET /api/generator/vps-contract',
    'PUT /api/generator/vps-contract',
    'GET /api/generator/logs',
    'POST /api/generator/generate/stop'
  ]);
  assert.equal(state.generatorRequests[6].search, '?lines=50&level=error', 'only the supported log parameters are forwarded');
  assert.deepEqual(JSON.parse(state.generatorRequests[2].body), expense);
  assert.deepEqual(JSON.parse(state.generatorRequests[5].body), {monthly_fee_jpy: 3000});

  const before = state.generatorRequests.length;
  assert.equal((await call(base + '/expenses/abc', 'DELETE')).status, 400);
  assert.equal((await call(base + '/expenses/1%2F..', 'DELETE')).status, 400);
  assert.equal((await call(base + '/logs?lines=abc')).status, 400);
  assert.equal((await call(base + '/logs?level=x;y')).status, 400);
  assert.equal(state.generatorRequests.length, before, 'invalid input must never reach the generator');
});

test('rules for the invite-campaign and giveaway pools top them up independently', async t => {
  const {state, call, sweep} = await runtime(t);

  const invite = await call(rulesPath, 'POST', {targetSystem: 'invite', minStock: 2, targetStock: 5, maxBatch: 3,
    vendingMachineId: 'ignored', productId: 'ignored'});
  assert.equal(invite.status, 201, JSON.stringify(invite.body));
  assert.equal(invite.body.machineName, '招待キャンペーン');
  assert.equal(invite.body.productId, 'invite-campaign', 'the pool name is the identity, whatever the client sent');
  assert.equal((await call(rulesPath, 'POST', {targetSystem: 'invite', minStock: 1, targetStock: 2, maxBatch: 1})).status, 409);
  const giveaway = await call(rulesPath, 'POST', {targetSystem: 'giveaway', minStock: 1, targetStock: 2, maxBatch: 2});
  assert.equal(giveaway.status, 201, JSON.stringify(giveaway.body));
  assert.equal(giveaway.body.machineName, '無料配布');

  await sweep();
  assert.equal(state.pools['invite-campaign'], 3, 'min(target - stock, maxBatch)');
  assert.equal(state.pools['free-giveaway'], 2);
  assert.equal(state.generatorPops.length, 2);
  await sweep();
  assert.equal(state.generatorPops.length, 2, 'pools at or above the minimum are left alone');

  const names = (await call(rulesPath)).body.map(r => r.targetSystem + ':' + r.productName).sort();
  assert.deepEqual(names, ['giveaway:在庫プール', 'invite:在庫プール']);
});

test('manual assignment puts generator accounts into a pool and validates input', async t => {
  const {state, call} = await runtime(t);
  const assign = `/api/guilds/${guildId}/generator/assign`;

  const ok = await call(assign, 'POST', {targetSystem: 'giveaway', count: 4, minWarmupDays: 1});
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(ok.body, {ok: true, popped: 4, added: 4});
  assert.deepEqual(state.generatorPops[0], {count: 4, min_warmup_days: 1, allow_soft_shadow: false, tier: 'any'});
  assert.equal(state.pools['free-giveaway'], 4);
  assert.equal(state.poolAdds[0].items[0], "user1:pw1:user1@mail.test::::::tok1");
  assert.deepEqual((await call(assign)).body, {pending: []});

  for (const payload of [
    {targetSystem: 'invite', count: 0}, {targetSystem: 'invite', count: 201},
    {targetSystem: 'invite', count: 1, minWarmupDays: -1}, {targetSystem: 'shiire', count: 1},
    {targetSystem: 'vending', count: 1, vendingMachineId: 'nope', productId: 'nope'}
  ]) {
    const response = await call(assign, 'POST', payload);
    assert.ok([400, 404].includes(response.status), JSON.stringify(payload) + ' -> ' + response.status);
  }
  assert.equal(state.generatorPops.length, 1, 'rejected requests never pop accounts');
});

test('accounts popped for a manual assignment are kept and redelivered when delivery fails', async t => {
  const {state, call, sweep} = await runtime(t);
  const assign = `/api/guilds/${guildId}/generator/assign`;

  state.shiireFailAdd = true;
  const failed = await call(assign, 'POST', {targetSystem: 'invite', count: 3});
  assert.equal(failed.status, 502);
  assert.match(failed.body.error, /保管済み/);
  const pending = (await call(assign)).body.pending;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].count, 3);
  assert.equal(pending[0].targetSystem, 'invite');
  assert.match(pending[0].lastError, /SHIIRE_API_ERROR/);
  assert.doesNotMatch(JSON.stringify(pending), /user1|pw1|tok1/, 'credentials are never returned');

  state.shiireFailAdd = false;
  await sweep();
  assert.equal(state.pools['invite-campaign'], 3);
  assert.equal(state.generatorPops.length, 1, 'redelivery must not pop again');
  assert.deepEqual((await call(assign)).body, {pending: []});
});

test('an empty generator is reported without leaving anything pending', async t => {
  const {state, call} = await runtime(t);
  const assign = `/api/guilds/${guildId}/generator/assign`;
  state.generatorOutOfStock = true;
  const response = await call(assign, 'POST', {targetSystem: 'giveaway', count: 2});
  assert.equal(response.status, 409);
  assert.match(response.body.error, /OUT_OF_STOCK/);
  assert.deepEqual((await call(assign)).body, {pending: []});
});

test('TOP_SEARCH products only receive graduated (search-verified) accounts; email password is delivered', async t => {
  const {state, call} = await runtime(t);
  state.shiireClass = 'TOP_SEARCH';
  const created = await call(rulesPath, 'POST', {
    targetSystem: 'shiire', vendingMachineId: 'sm1', productId: 'sp1', minStock: 2, targetStock: 3, maxBatch: 3
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal((await call(rulesPath + '/' + created.body.id + '/run-now', 'POST')).status, 200);
  assert.equal(state.generatorPops[0].tier, 'top_search');
  assert.ok(state.shiireAdds[0].length > 0);
});
