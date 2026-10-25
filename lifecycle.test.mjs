import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CapacityWorker } from './worker.mjs';
import { defaultSettings, dueActivations } from './core.mjs';

const initialTime = () => new Date(2026, 9, 25, 8, 0, 30).getTime();
const enabledSettings = () => ({ ...structuredClone(defaultSettings), enabled: true });

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

class MockClient extends EventEmitter {
  constructor(clock, onSelect = async () => {}) {
    super();
    this.clock = clock;
    this.onSelect = onSelect;
    this.closed = false;
    this.started = 0;
    this.activations = 0;
  }

  async start() { this.started++; }
  close() { this.closed = true; }
  async readLimits() {
    return { rateLimits: {
      limitId: 'codex',
      primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: Math.floor(this.clock() / 1000) + 18000 },
      secondary: { usedPercent: 20, windowDurationMins: 10080, resetsAt: Math.floor(this.clock() / 1000) + 604800 },
    } };
  }
  async selectModel() {
    await this.onSelect();
    return { model: 'mock-no-network', displayName: 'Mock' };
  }
  async activate(_model, { beforeSend } = {}) {
    beforeSend?.();
    this.activations++;
  }
}

async function fixture(t) {
  const tempRoot = path.resolve(os.tmpdir());
  const dir = await mkdtemp(path.join(tempRoot, 'codex-capacity-lifecycle-'));
  const workers = [];
  t.after(async () => {
    for (const worker of workers.toReversed()) await worker.stop();
    // Cleanup is confined to this test's newly created temporary directory.
    assert.equal(path.dirname(dir), tempRoot);
    assert.ok(path.basename(dir).startsWith('codex-capacity-lifecycle-'));
    await rm(dir, { recursive: true, force: true });
  });
  return {
    dir,
    worker(options = {}) {
      const worker = new CapacityWorker(dir, {
        findExecutable: async () => 'mock-no-executable',
        clientFactory: () => { throw new Error('This test must not start a real client.'); },
        ...options,
      });
      workers.push(worker);
      return worker;
    },
  };
}

async function enable(worker, settings = enabledSettings()) {
  await worker.init();
  await worker.handleCommand({ id: 'enable-for-test', type: 'saveSettings', payload: settings });
  return dueActivations(worker.state.settings, worker.clock())[0];
}

test('model discovery that outlasts the two-minute grace period cannot activate', async t => {
  const f = await fixture(t);
  let now = initialTime();
  const client = new MockClient(() => now, async () => { now += 180000; });
  const worker = f.worker({ clock: () => now, clientFactory: () => client });
  const slot = await enable(worker);

  await assert.rejects(worker.activate({ slot }), /错过|宽限|取消/);

  assert.equal(client.activations, 0);
  assert.ok(worker.ledger.completedKeys.includes(slot.key), 'the cancelled slot stays claimed');
});

test('stopping while executable discovery is pending does not create or start a client', async t => {
  const f = await fixture(t);
  const discovery = deferred();
  let clientsCreated = 0;
  const worker = f.worker({
    findExecutable: () => discovery.promise,
    clientFactory: () => {
      clientsCreated++;
      return new MockClient(initialTime);
    },
  });
  await worker.init();
  const connecting = worker.connect();
  const cancelled = assert.rejects(connecting, /退出|取消/);

  await worker.stop();
  discovery.resolve('mock-no-executable');
  await cancelled;

  assert.equal(clientsCreated, 0);
  assert.equal(worker.client, undefined);
});

for (const scenario of ['missing', 'incomplete']) {
  test(`an enabled plan is paused when its ledger is ${scenario}`, async t => {
    const f = await fixture(t);
    await writeFile(path.join(f.dir, 'settings.json'), JSON.stringify(enabledSettings()));
    if (scenario === 'incomplete') await writeFile(path.join(f.dir, 'ledger.json'), '{}');
    const worker = f.worker();

    await worker.init();

    assert.equal(worker.state.settings.enabled, false);
    assert.equal(JSON.parse(await readFile(path.join(f.dir, 'settings.json'), 'utf8')).enabled, false);
    assert.ok(worker.ledger.history.some(entry => entry.type === 'error' && /触发记录/.test(entry.message)));
  });
}

test('a second worker that cannot acquire the lock cannot overwrite the first worker state', async t => {
  const f = await fixture(t);
  const first = f.worker();
  await first.init();
  first.state.message = 'First worker owns this state.';
  await first.publish();
  const stateBefore = await readFile(path.join(f.dir, 'state.json'), 'utf8');
  const lockBefore = await readFile(path.join(f.dir, 'worker.lock'), 'utf8');
  const second = f.worker();

  await assert.rejects(second.init(), /已在运行|锁文件/);
  await second.stop();

  assert.equal(await readFile(path.join(f.dir, 'state.json'), 'utf8'), stateBefore);
  assert.equal(await readFile(path.join(f.dir, 'worker.lock'), 'utf8'), lockBefore);
  assert.equal(first.stopped, false);
});

test('saving a plan that removes the current slot during model discovery cancels activation', async t => {
  const f = await fixture(t);
  let worker;
  const client = new MockClient(initialTime, async () => {
    await worker.handleCommand({
      id: 'reschedule-during-model-discovery',
      type: 'saveSettings',
      payload: { ...enabledSettings(), times: ['13:00', '18:00'] },
    });
  });
  worker = f.worker({ clock: initialTime, clientFactory: () => client });
  const slot = await enable(worker);

  await assert.rejects(worker.activate({ slot }), /设置已变更|取消/);

  assert.equal(client.activations, 0);
  assert.deepEqual(worker.state.settings.times, ['13:00', '18:00']);
  assert.ok(worker.ledger.completedKeys.includes(slot.key));
});
