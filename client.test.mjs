import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CodexClient } from './client.mjs';

function harness(handler, options = {}) {
  const requests = [];
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => { child.killed = true; child.emit('close', 0); };
  const reply = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  child.stdin.on('data', data => {
    const request = JSON.parse(String(data));
    requests.push(request);
    if (request.method === 'initialize') reply({ id: request.id, result: {} });
    else if (request.id !== undefined && request.method) handler(request, reply);
  });
  const client = new CodexClient('test-codex.exe', process.cwd(), { timeoutMs: 1000, ...options, spawnImpl: (_exe, args, spawnOptions) => {
    assert.equal(spawnOptions.shell, false);
    assert.equal(spawnOptions.windowsHide, true);
    assert.ok(args.includes('features.hooks=false'));
    return child;
  } });
  return { client, child, requests, reply };
}

test('metadata queries complete initialization and never send a turn or return account identity', async () => {
  const h = harness((r, reply) => reply({ id: r.id, result: r.method === 'account/read'
    ? { account: { type: 'chatgpt', email: 'fixture@example.invalid', planType: 'plus' } }
    : { rateLimits: { limitId: 'codex' } } }));
  try {
    await h.client.start();
    assert.deepEqual(await h.client.readAccount(), { isChatGPT: true, planType: 'plus' });
    await h.client.readLimits();
    assert.deepEqual(h.requests.map(r => r.method), ['initialize', 'initialized', 'account/read', 'account/read', 'account/rateLimits/read']);
  } finally { h.client.close(); }
});

test('API-key login cannot read subscription limits or cause inference', async () => {
  const h = harness((r, reply) => reply({ id: r.id, result: { account: { type: 'apiKey' } } }));
  try {
    await h.client.start();
    await assert.rejects(h.client.readLimits(), /ChatGPT/);
    assert.equal(h.requests.filter(r => r.method === 'account/rateLimits/read' || r.method === 'turn/start').length, 0);
  } finally { h.client.close(); }
});

test('an unavailable explicitly selected model fails instead of silently substituting one', async () => {
  const h = harness((r, reply) => reply({ id: r.id, result: { data: [{ id: 'available', model: 'available', isDefault: true }] } }));
  try { await h.client.start(); await assert.rejects(h.client.selectModel('missing'), /指定模型/); }
  finally { h.client.close(); }
});

test('early turn completion is accepted and the ephemeral turn has no automatic replay', async () => {
  const h = harness((r, reply) => {
    if (r.method === 'account/read') reply({ id: r.id, result: { account: { type: 'chatgpt' } } });
    else if (r.method === 'thread/start') {
      assert.equal(r.params.ephemeral, true);
      assert.equal(r.params.sandbox, 'read-only');
      reply({ id: r.id, result: { thread: { id: 'test-thread' } } });
    } else if (r.method === 'turn/start') {
      reply({ method: 'turn/completed', params: { threadId: 'test-thread', turn: { id: 't1', status: 'completed' } } });
      reply({ id: r.id, result: { turn: { id: 't1' } } });
    } else reply({ id: r.id, result: {} });
  });
  try {
    await h.client.start();
    let guards = 0;
    await h.client.activate({ model: 'test-model' }, { beforeSend: () => guards++ });
    assert.equal(guards, 2);
    assert.equal(h.requests.filter(r => r.method === 'turn/start').length, 1);
    assert.equal(h.requests.filter(r => r.method === 'turn/interrupt').length, 0);
  } finally { h.client.close(); }
});

test('a final cancellation after thread setup prevents any model turn', async () => {
  const h = harness((r, reply) => reply({ id: r.id, result: r.method === 'account/read'
    ? { account: { type: 'chatgpt' } } : r.method === 'thread/start' ? { thread: { id: 'test-thread' } } : {} }));
  try {
    await h.client.start();
    let guards = 0;
    await assert.rejects(h.client.activate({ model: 'test-model' }, { beforeSend: () => { if (++guards === 2) throw new Error('cancelled'); } }), /cancelled/);
    assert.equal(h.requests.filter(r => r.method === 'turn/start').length, 0);
  } finally { h.client.close(); }
});

test('RPC timeout closes the subprocess without retrying and remote error text is discarded', async () => {
  const h = harness((r, reply) => { if (r.method === 'bad') reply({ id: r.id, error: { code: 401, message: 'fixture-sensitive-content' } }); }, { timeoutMs: 25 });
  try {
    await h.client.start();
    await assert.rejects(h.client.request('bad'), error => !error.message.includes('fixture-sensitive-content') && error.rpcCode === 401);
    await assert.rejects(h.client.request('timeout'), /超时/);
    assert.equal(h.child.killed, true);
    assert.equal(h.requests.filter(r => r.method === 'timeout').length, 1);
  } finally { h.client.close(); }
});
