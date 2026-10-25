import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, stat, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CapacityWorker, atomicJSON } from './worker.mjs';
import { defaultSettings } from './core.mjs';

const at = (hour, minute = 0, second = 0) => new Date(2026, 9, 25, hour, minute, second).getTime();
const json = async file => JSON.parse(await readFile(file, 'utf8'));

async function harness(t, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-capacity-worker-test-'));
  const calls = { start: 0, readLimits: 0, readAccount: 0, selectModel: 0, activate: 0, close: 0 };
  let now = options.now ?? at(8);
  const workers = [];
  class FakeClient extends EventEmitter {
    closed = false;
    async start() { calls.start++; }
    async readLimits() {
      calls.readLimits++;
      return {
        rateLimits: {
          limitId: 'codex',
          primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: Math.floor(now / 1_000) + 3_600, ...options.primary },
          secondary: options.secondary ?? null
        }
      };
    }
    async readAccount() { calls.readAccount++; return { account: { type: 'chatgpt' } }; }
    async selectModel() { calls.selectModel++; return { model: 'mock-model', displayName: 'Mock model' }; }
    async activate() {
      calls.activate++;
      if (options.activateError) throw new Error(options.activateError);
    }
    close() { if (!this.closed) calls.close++; this.closed = true; }
  }
  const createWorker = async () => {
    const worker = new CapacityWorker(dir, {
      clock: () => now,
      findExecutable: async () => path.join(dir, 'never-launched-codex.exe'),
      clientFactory: () => new FakeClient()
    });
    await worker.init();
    workers.push(worker);
    return worker;
  };
  t.after(async () => {
    for (const worker of workers) {
      await worker.operation?.catch(() => {});
      await worker.stop().catch(() => {});
      await worker.writeChain.catch(() => {});
    }
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, calls, createWorker, setTime: value => { now = value; }, getTime: () => now };
}

async function tickAndFinish(worker) {
  await worker.tick();
  await worker.operation;
  await worker.writeChain;
  assert.equal(worker.state.busy, false);
}

async function enableSchedule(worker, times = ['08:00', '13:00']) {
  await worker.handleCommand({
    id: randomUUID(), type: 'saveSettings',
    payload: { ...defaultSettings, enabled: true, times }
  });
}

async function enqueue(dir, command, modifiedAt) {
  const file = path.join(dir, 'commands', `${command.id}.json`);
  await atomicJSON(file, command);
  if (modifiedAt !== undefined) await utimes(file, new Date(modifiedAt), new Date(modifiedAt));
}

test('new installation stays paused while synchronizing metadata without inference', async t => {
  const h = await harness(t);
  const worker = await h.createWorker();
  await tickAndFinish(worker);
  assert.equal(worker.state.settings.enabled, false);
  assert.equal(worker.state.connection, 'ready');
  assert.ok(h.calls.readLimits > 0);
  assert.equal(h.calls.activate, 0);
  assert.equal(h.calls.selectModel, 0);
  assert.equal(worker.state.nextActivation, null);
});

test('a scheduled slot sends at most once even after repeated ticks and a worker restart', async t => {
  const h = await harness(t);
  const first = await h.createWorker();
  await enableSchedule(first);
  await tickAndFinish(first);
  assert.equal(h.calls.activate, 1);
  assert.ok((await json(path.join(h.dir, 'ledger.json'))).completedKeys.includes('2026-10-25/08:00'));
  h.setTime(at(8, 0, 45));
  await tickAndFinish(first);
  assert.equal(h.calls.activate, 1);
  await first.stop();
  const second = await h.createWorker();
  assert.equal(second.state.settings.enabled, true);
  await tickAndFinish(second);
  assert.equal(h.calls.activate, 1);
  assert.equal(second.state.nextActivation.time, '13:00');
});

test('a five-hour window already in use skips activation without discovering a model', async t => {
  const h = await harness(t, { primary: { usedPercent: 18 } });
  const worker = await h.createWorker();
  await enableSchedule(worker);
  await tickAndFinish(worker);
  assert.equal(h.calls.activate, 0);
  assert.equal(h.calls.selectModel, 0);
  assert.match(worker.state.message, /已在使用/);
  assert.ok((await json(path.join(h.dir, 'ledger.json'))).completedKeys.includes('2026-10-25/08:00'));
});

test('an exhausted shared weekly allowance blocks activation despite an unused five-hour allowance', async t => {
  const h = await harness(t, {
    secondary: { usedPercent: 100, windowDurationMins: 10_080, resetsAt: Math.floor(at(8) / 1_000) + 86_400 }
  });
  const worker = await h.createWorker();
  await enableSchedule(worker);
  await tickAndFinish(worker);
  assert.equal(h.calls.activate, 0);
  assert.match(worker.state.message, /已用尽/);
});

test('an ambiguous inference failure is never retried by metadata polling or restart', async t => {
  const h = await harness(t, { activateError: 'mock request outcome unknown' });
  const first = await h.createWorker();
  await enableSchedule(first);
  await tickAndFinish(first);
  assert.equal(h.calls.activate, 1);
  assert.equal(first.state.connection, 'error');
  const persisted = await json(path.join(h.dir, 'ledger.json'));
  assert.equal(persisted.lastAttemptAt, at(8));
  assert.ok(persisted.completedKeys.includes('2026-10-25/08:00'));
  const previousReads = h.calls.readLimits;
  h.setTime(at(8, 1, 1));
  await tickAndFinish(first);
  assert.ok(h.calls.readLimits > previousReads, 'subsequent metadata refresh remains available');
  assert.equal(first.state.connection, 'ready');
  assert.equal(h.calls.activate, 1);
  await first.stop();
  const restarted = await h.createWorker();
  h.setTime(at(8, 1, 2));
  await tickAndFinish(restarted);
  assert.equal(h.calls.activate, 1);
  h.setTime(at(8, 5));
  await tickAndFinish(restarted);
  assert.equal(h.calls.activate, 1);
});

test('an invalid settings command reports failure and preserves the previous saved plan', async t => {
  const h = await harness(t);
  const worker = await h.createWorker();
  await enableSchedule(worker, ['09:00']);
  const original = structuredClone(worker.state.settings);
  const id = randomUUID();
  await enqueue(h.dir, { id, type: 'saveSettings', payload: { ...original, times: ['99:99'] } }, h.getTime());
  await tickAndFinish(worker);
  assert.deepEqual(worker.state.settings, original);
  assert.deepEqual(await json(path.join(h.dir, 'settings.json')), original);
  assert.equal(worker.state.lastCommand.id, id);
  assert.equal(worker.state.lastCommand.ok, false);
  assert.match(worker.state.lastCommand.message, /HH:mm/);
  assert.equal(h.calls.activate, 0);
});

test('an expired local activate command is rejected without sending inference', async t => {
  const h = await harness(t);
  const worker = await h.createWorker();
  const id = randomUUID();
  await enqueue(h.dir, { id, type: 'activate' }, h.getTime() - 180_000);
  await tickAndFinish(worker);
  assert.equal(worker.state.lastCommand.id, id);
  assert.equal(worker.state.lastCommand.ok, false);
  assert.match(worker.state.lastCommand.message, /过期/);
  assert.equal(h.calls.activate, 0);
});

test('shutdown closes the client, removes the ownership lock and permits a fresh instance', async t => {
  const h = await harness(t);
  const worker = await h.createWorker();
  await tickAndFinish(worker);
  const lockFile = path.join(h.dir, 'worker.lock');
  assert.ok((await stat(lockFile)).isFile());
  const duplicate = new CapacityWorker(h.dir, { clock: h.getTime });
  await assert.rejects(duplicate.init(), /已在运行/);
  await worker.handleCommand({ id: randomUUID(), type: 'shutdown' });
  assert.equal(h.calls.close, 1);
  assert.equal(worker.stopped, true);
  await assert.rejects(stat(lockFile), error => error.code === 'ENOENT');
  assert.equal((await json(path.join(h.dir, 'state.json'))).connection, 'offline');
  const restarted = await h.createWorker();
  assert.equal(restarted.stopped, false);
  assert.ok((await stat(lockFile)).isFile());
});

test('shutdown during post-activation calibration never reopens a client', async t => {
  const h = await harness(t);
  const worker = await h.createWorker();
  assert.equal(worker.runOperation(() => worker.activate()), true);
  // The mock request itself completes immediately; pause while the worker awaits calibration.
  while (h.calls.activate === 0 && worker.state.busy) await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.activate, 1);
  const readsBeforeStop = h.calls.readLimits;
  await worker.stop();
  await worker.operation;
  assert.equal(h.calls.start, 1, 'exiting must not reconnect after the calibration delay');
  assert.equal(h.calls.readLimits, readsBeforeStop);
  assert.equal(worker.state.connection, 'offline');
});
