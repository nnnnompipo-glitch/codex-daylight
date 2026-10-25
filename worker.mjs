import { APP_VERSION } from './identity.mjs';
import { mkdir, readFile, readdir, rename, rm, open, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CodexClient, findCodex } from './client.mjs';
import { defaultSettings, validateSettings, normalizeQuota, computeNextActivation, dueActivations, activationDecision } from './core.mjs';

const VERSION = APP_VERSION;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function atomicJSON(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    for (let attempt = 0; ; attempt++) {
      try { await rename(temp, file); break; }
      catch (error) { if (attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error; await delay(30); }
    }
  } finally { await rm(temp, { force: true }).catch(() => {}); }
}

async function readJSON(file, fallback) {
  try { return JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
const isAlive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

export class CapacityWorker {
  constructor(dataDir, { parentPid = null, clientFactory, clock = Date.now, findExecutable = findCodex } = {}) {
    this.dir = path.resolve(dataDir);
    this.parentPid = parentPid;
    this.clientFactory = clientFactory || ((exe, cwd) => new CodexClient(exe, cwd));
    this.findExecutable = findExecutable;
    this.clock = clock;
    this.ledger = { completedKeys: [], history: [], lastAttemptAt: 0 };
    this.state = {
      version: VERSION, workerPid: process.pid, connection: 'starting', busy: false,
      message: '正在连接 Codex；计划默认暂停。', settings: structuredClone(defaultSettings),
      quota: null, nextActivation: null, lastCommand: null, history: [], modelName: '',
    };
    this.lastPoll = 0;
    this.tickBusy = false;
    this.stopped = false;
    this.writeChain = Promise.resolve();
  }

  async init() {
    await mkdir(this.dir, { recursive: true });
    this.lockPath = path.join(this.dir, 'worker.lock');
    const oldLock = await readJSON(this.lockPath, null).catch(() => ({ unreadable: true }));
    if (oldLock && (!Number.isInteger(oldLock.pid) || isAlive(oldLock.pid))) throw new Error('额度管家已在运行或锁文件尚未完成写入，请检查已有窗口或系统托盘。');
    // Remove only a parsed lock whose process is verified dead.
    if (oldLock) await rm(this.lockPath, { force: true });
    this.lock = await open(this.lockPath, 'wx', 0o600);
    await this.lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date(this.clock()).toISOString() }));
    for (const dir of ['commands', 'sandbox']) await mkdir(path.join(this.dir, dir), { recursive: true });
    try {
      this.state.settings = validateSettings(await readJSON(path.join(this.dir, 'settings.json'), defaultSettings));
    } catch {
      this.state.settings = structuredClone(defaultSettings);
      this.addHistory('error', '设置文件损坏，已暂停计划。请重新保存设置。');
    }
    try {
      const ledger = await readJSON(path.join(this.dir, 'ledger.json'), null);
      if (ledger === null && this.state.settings.enabled) throw new Error('历史记录缺失。');
      if (ledger && (!Array.isArray(ledger.completedKeys) || !Array.isArray(ledger.history) || !Number.isFinite(ledger.lastAttemptAt))) throw new Error('历史记录不完整。');
      this.ledger.completedKeys = ledger?.completedKeys?.filter(k => typeof k === 'string').slice(-200) || [];
      this.ledger.lastAttemptAt = ledger?.lastAttemptAt || 0;
      if (ledger?.history) this.ledger.history.push(...ledger.history.filter(h => typeof h?.at === 'string' && typeof h?.message === 'string').slice(-80));
    } catch {
      // A missing/corrupt ledger cannot safely prove that today's slots were not already sent.
      this.state.settings.enabled = false;
      this.addHistory('error', '触发记录损坏，已暂停计划，避免重复激活。请检查后重新启用。');
    }
    await this.persistSettings();
    await this.persistLedger();
    await this.publish();
    return this;
  }

  addHistory(type, message) {
    this.ledger.history.unshift({ at: new Date(this.clock()).toISOString(), type, message });
    this.ledger.history = this.ledger.history.slice(0, 80);
    this.state.message = message;
  }
  persistSettings() { return atomicJSON(path.join(this.dir, 'settings.json'), this.state.settings); }
  persistLedger() { return atomicJSON(path.join(this.dir, 'ledger.json'), this.ledger); }

  publish() {
    this.state.updatedAt = new Date(this.clock()).toISOString();
    this.state.history = this.ledger.history.slice(0, 50);
    this.state.nextActivation = computeNextActivation(this.state.settings, this.clock(), this.ledger.completedKeys);
    if (this.state.quota) this.state.quota.stale = this.state.connection !== 'ready' || this.clock() - Date.parse(this.state.quota.fetchedAt) > Math.max(120000, this.state.settings.pollSeconds * 2000);
    const snapshot = structuredClone(this.state);
    const write = this.writeChain.catch(() => {}).then(() => atomicJSON(path.join(this.dir, 'state.json'), snapshot));
    this.writeChain = write;
    return write;
  }

  async connect() {
    if (this.stopped) throw new Error('工具已退出，取消连接。');
    if (this.client && !this.client.closed) return this.client;
    const executable = await this.findExecutable();
    if (this.stopped) throw new Error('工具已退出，取消连接。');
    const client = this.clientFactory(executable, path.join(this.dir, 'sandbox'));
    this.client = client;
    client.on('disconnected', () => {
      if (this.client !== client || this.stopped) return;
      this.state.connection = 'offline';
      if (this.state.quota) this.state.quota.stale = true;
      this.state.message = 'Codex 连接已断开；显示的是最后同步数据。';
      void this.publish().catch(() => {});
    });
    client.on('notification', event => {
      if (event.method !== 'account/rateLimits/updated' || this.stopped) return;
      // The notification can describe a different bucket. Do not replace Codex data with it.
      const quota = normalizeQuota(event.params, this.clock());
      if (quota) { this.state.quota = quota; void this.publish().catch(() => {}); }
    });
    try {
      await client.start();
      if (this.stopped) { client.close(); throw new Error('工具已退出，取消连接。'); }
    }
    catch (error) { client.close(); throw error; }
    return client;
  }

  async refresh() {
    if (this.stopped) throw new Error('工具已退出，停止同步。');
    this.lastPoll = this.clock();
    const client = await this.connect();
    const quota = normalizeQuota(await client.readLimits(), this.clock());
    if (!quota) throw new Error('服务端没有返回 Codex 额度桶，已停止激活。');
    this.state.quota = quota;
    this.state.connection = 'ready';
    this.state.message = quota.fiveHour ? '已同步服务端恢复时间。激活不能提前恢复或增加额度。' : '账号未返回五小时额度窗口；仅显示实际额度，计划不会触发。';
    return quota;
  }

  // Record a scheduled slot before any network action: an ambiguous failure must never be resent.
  async claimSlot(key) {
    if (this.ledger.completedKeys.includes(key)) return false;
    this.ledger.completedKeys.push(key);
    this.ledger.completedKeys = this.ledger.completedKeys.slice(-200);
    await this.persistLedger();
    return true;
  }

  async activate({ slot = null } = {}) {
    const originalSettings = JSON.stringify(this.state.settings);
    if (slot && !await this.claimSlot(slot.key)) return;
    if (this.clock() - this.ledger.lastAttemptAt < 15 * 60 * 1000) {
      this.addHistory('skip', '距离上次激活尝试不足 15 分钟，已跳过，避免重复消耗。');
      return;
    }
    const quota = await this.refresh();
    if (slot && (!this.state.settings.enabled || !dueActivations(this.state.settings, this.clock(), []).some(s => s.key === slot.key))) {
      this.addHistory('skip', '计划已暂停、时间已修改或已超出触发宽限期，本次跳过。');
      return;
    }
    const decision = activationDecision(quota, this.state.settings, this.clock());
    if (!decision.allow) { this.addHistory('skip', decision.reason); return; }
    const model = await this.client.selectModel(this.state.settings.model);
    // Model discovery may have taken time. Recheck limits immediately before inference.
    const latest = await this.refresh();
    const finalDecision = activationDecision(latest, this.state.settings, this.clock());
    if (!finalDecision.allow) { this.addHistory('skip', finalDecision.reason); return; }
    const beforeSend = () => {
      if (this.stopped || JSON.stringify(this.state.settings) !== originalSettings) throw new Error('设置已变更或工具已退出，本次激活已取消。');
      if (slot && (!this.state.settings.enabled || !dueActivations(this.state.settings, this.clock(), []).some(s => s.key === slot.key))) throw new Error('已错过定时时段或计划已暂停，本次激活已取消。');
      const checked = activationDecision(latest, this.state.settings, this.clock());
      if (!checked.allow) throw new Error(checked.reason);
    };
    beforeSend();
    this.state.modelName = model.displayName || model.model;
    this.ledger.lastAttemptAt = this.clock();
    this.addHistory('attempt', `${slot ? `定时 ${slot.time}` : '手动'}：正在发送一次轻量请求（${model.model}）。`);
    await this.persistLedger();
    await this.publish();
    await this.client.activate(model, { beforeSend });
    this.addHistory('success', '轻量请求已完成；正在校准实际恢复时间，不保证窗口已重排。');
    await this.persistLedger();
    // Only metadata is retried by later polling. A model request is never retried automatically.
    try {
      await delay(1000);
      if (this.stopped) return;
      await this.refresh();
      this.addHistory('success', '激活后已同步实际恢复时间。是否调整窗口以服务端结果为准。');
    } catch {
      this.state.connection = 'offline';
      if (this.state.quota) this.state.quota.stale = true;
      this.addHistory('error', '轻量请求已完成，但恢复时间暂未校准；不会重新发送请求。');
    }
  }

  runOperation(action, commandId = null) {
    if (this.state.busy || this.stopped) return false;
    this.state.busy = true;
    void this.publish().catch(() => {});
    this.operation = (async () => {
      try {
        await action();
        if (commandId) this.state.lastCommand = { id: commandId, ok: true, message: this.state.message };
      } catch (error) {
        this.state.connection = 'error';
        if (this.state.quota) this.state.quota.stale = true;
        this.addHistory('error', error.message || '执行失败，请检查 Codex 登录与网络。');
        if (commandId) this.state.lastCommand = { id: commandId, ok: false, message: this.state.message };
      } finally {
        this.state.busy = false;
        if (!this.stopped) { await this.persistLedger(); await this.publish(); }
      }
    })().catch(() => { this.state.message = '本地状态保存失败，已停止计划，请检查磁盘空间与目录权限。'; this.state.settings.enabled = false; });
    return true;
  }

  async handleCommand(command, ageMs = 0) {
    if (typeof command?.id !== 'string' || command.id.length > 100) throw new Error('命令格式无效。');
    const done = (ok, message) => { this.state.lastCommand = { id: command.id, ok, message }; this.state.message = message; };
    switch (command.type) {
      case 'saveSettings': {
        const settings = validateSettings(command.payload);
        this.state.settings = settings;
        await this.persistSettings();
        this.addHistory('settings', settings.enabled ? '已保存并启用定时计划。' : '已保存设置，定时计划已暂停。');
        done(true, this.state.message);
        break;
      }
      case 'pause':
        this.state.settings.enabled = false;
        await this.persistSettings();
        this.addHistory('settings', '定时计划已暂停。');
        done(true, this.state.message);
        break;
      case 'refresh':
      case 'activate':
        if (ageMs > 120000 || ageMs < -10000) done(false, '命令已过期，请重新点击操作。');
        else if (!this.runOperation(() => command.type === 'refresh' ? this.refresh() : this.activate(), command.id)) done(false, '正在处理上一项操作，请稍候。');
        break;
      case 'shutdown': await this.stop(); return;
      default: throw new Error('不支持的本地命令。');
    }
    if (!this.stopped) await this.publish();
  }

  async tick() {
    if (this.tickBusy || this.stopped) return;
    this.tickBusy = true;
    try {
      const files = (await readdir(path.join(this.dir, 'commands'))).filter(f => /^[a-z0-9-]+\.json$/i.test(f)).sort();
      for (const file of files.slice(0, 20)) {
        const source = path.join(this.dir, 'commands', file);
        const claimed = `${source}.working`;
        try { await rename(source, claimed); } catch { continue; }
        try {
          const info = await stat(claimed);
          if (info.size > 65536) throw new Error('本地命令过大。');
          const command = await readJSON(claimed);
          try { await this.handleCommand(command, this.clock() - info.mtimeMs); }
          catch (error) { this.state.lastCommand = { id: command?.id, ok: false, message: error.message }; this.state.message = error.message; }
        } catch { this.addHistory('error', '忽略了无效的本地命令文件。'); }
        finally { await rm(claimed, { force: true }).catch(() => {}); }
        if (this.stopped) return;
      }
      if (!this.state.busy) {
        const slots = dueActivations(this.state.settings, this.clock(), this.ledger.completedKeys);
        if (slots.length) {
          // Closely spaced slots are coalesced; never batch model requests after a delayed tick.
          for (const slot of slots.slice(0, -1)) await this.claimSlot(slot.key);
          this.runOperation(() => this.activate({ slot: slots.at(-1) }));
        } else if (this.clock() - this.lastPoll >= this.state.settings.pollSeconds * 1000) {
          this.runOperation(() => this.refresh());
        }
      }
      await this.publish();
    } finally { this.tickBusy = false; }
  }

  async start() {
    await this.init();
    this.watchdog = setInterval(() => {
      if (this.parentPid && !isAlive(this.parentPid)) void this.stop();
    }, 2000);
    this.timer = setInterval(() => { void this.tick().catch(() => {
      this.state.settings.enabled = false;
      this.state.message = '本地文件访问失败，已暂停计划。请检查数据目录。';
    }); }, 1000);
    await this.tick();
    return this;
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    clearInterval(this.watchdog);
    this.client?.close();
    // An init failure before lock acquisition must not overwrite another worker's snapshot.
    if (!this.lock) return;
    this.state.busy = false;
    this.state.connection = 'offline';
    this.state.message = '额度管家已退出；计划将在下次启动后按设置执行。';
    await this.publish().catch(() => {});
    await this.lock?.close().catch(() => {});
    if (this.lock) await rm(this.lockPath, { force: true }).catch(() => {});
  }
}

export async function checkConnection() {
  const dir = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'CodexCapacity', 'sandbox');
  await mkdir(dir, { recursive: true });
  const client = new CodexClient(await findCodex(), dir);
  try {
    await client.start();
    const quota = normalizeQuota(await client.readLimits());
    if (!quota) throw new Error('没有收到 Codex 额度桶。');
    // No inference, email, account IDs, credentials, or raw responses in this diagnostic.
    return { ok: true, inferenceSent: false, quota };
  } finally { client.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check')) {
    try { console.log(JSON.stringify(await checkConnection(), null, 2)); }
    catch (error) { console.log(JSON.stringify({ ok: false, inferenceSent: false, message: error.message })); process.exitCode = 1; }
  } else {
    const args = process.argv.slice(2);
    const value = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : null; };
    const dir = value('--data-dir') || path.join(process.env.LOCALAPPDATA || os.homedir(), 'CodexCapacity');
    const parent = Number(value('--parent-pid')) || null;
    const worker = new CapacityWorker(dir, { parentPid: parent });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void worker.stop(); });
    try { await worker.start(); }
    catch (error) { console.error(error.message); await worker.stop(); process.exitCode = 1; }
  }
}
