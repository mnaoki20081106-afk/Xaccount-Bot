import test from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare} from 'miniflare';

const guildId = '123456789012345678';
const botId = '423456789012345678';
const generatorSecret = 'generator-secret-longer-than-32-characters';
const shiireSecret = 'shiire-secret-longer-than-32-characters-x';

async function runtime(t) {
  const state = {
    generatorPops: [],
    generatorOutOfStock: false,
    shiireStock: 0,
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
        assert.ok(request.headers.get('X-Generator-Signature'), 'generator calls must be signed');
        assert.equal(url.pathname, '/api/generator/pop');
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
            {id: 'sp1', name: 'Shiire product', procurement_class: 'NO_SHADOWBAN', stock_count: state.shiireStock}
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
  assert.deepEqual(state.generatorPops[0], {count: 4, min_warmup_days: 0, allow_soft_shadow: false});

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
  assert.deepEqual(state.generatorPops[0], {count: 3, min_warmup_days: 2, allow_soft_shadow: false});
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
  assert.match(state.shiireAdds[0][0], /^user1:pw1\|user1@mail\.test\|auth_token=tok1$/);
  assert.equal(state.shiireStock, 3);
  rule = (await call(rulesPath)).body[0];
  assert.equal(rule.pendingDelivery, false);
  assert.equal(rule.lastError, null);

  // Stock 3 >= minimum 2: nothing more happens.
  await sweep();
  assert.equal(state.generatorPops.length, 1);
  assert.equal((await call(rulesPath + '/' + rule.id, 'DELETE')).status, 200);
});
