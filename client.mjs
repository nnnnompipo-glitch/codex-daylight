import { APP_VERSION } from './identity.mjs';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { access, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';

// Discover executable paths only. Authentication remains entirely inside Codex.
export async function findCodex(env = process.env) {
  const name = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const candidates = [];
  if (env.CODEX_CAPACITY_CODEX) candidates.push(env.CODEX_CAPACITY_CODEX);
  const dirs = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) candidates.push(path.join(dir.replace(/^"|"$/g, ''), name));
  if (env.LOCALAPPDATA) {
    const desktop = path.join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    candidates.push(path.join(desktop, name));
    const versions = await readdir(desktop, { withFileTypes: true }).catch(() => []);
    const files = await Promise.all(versions.filter(v => v.isDirectory()).slice(0, 256).map(async v => {
      const file = path.join(desktop, v.name, name);
      return { file, mtime: (await stat(file).catch(() => null))?.mtimeMs || 0 };
    }));
    candidates.push(...files.sort((a, b) => b.mtime - a.mtime).map(f => f.file));
    candidates.push(path.join(env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin', name));
  }
  const triple = { 'win32-x64': 'x86_64-pc-windows-msvc', 'win32-arm64': 'aarch64-pc-windows-msvc' }[`${process.platform}-${process.arch}`];
  if (triple) {
    const roots = dirs.map(dir => path.join(dir, 'node_modules'));
    if (env.APPDATA) roots.push(path.join(env.APPDATA, 'npm', 'node_modules'));
    for (const root of roots) for (const base of [
      path.join(root, '@openai', `codex-${process.platform}-${process.arch}`),
      path.join(root, '@openai', 'codex', 'node_modules', '@openai', `codex-${process.platform}-${process.arch}`),
      path.join(root, '@openai', 'codex'),
    ]) candidates.push(path.join(base, 'vendor', triple, 'codex', name));
  }
  for (const candidate of candidates) {
    if (process.platform === 'win32' && path.extname(candidate).toLowerCase() !== '.exe') continue;
    if (await access(candidate).then(() => true, () => false)) return candidate;
  }
  throw new Error('未找到 Codex CLI。请安装 Codex 并使用 ChatGPT 账号登录。');
}

export class CodexClient extends EventEmitter {
  constructor(executable, cwd, { spawnImpl = spawn, timeoutMs = 25000 } = {}) {
    super();
    this.executable = executable;
    this.cwd = cwd;
    this.spawnImpl = spawnImpl;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.sequence = 0;
    this.closed = false;
  }

  async start() {
    // Disable integrations and local execution for this process, never edit the user's configuration.
    const disabled = ['hooks', 'shell_tool', 'unified_exec', 'plugins', 'apps', 'multi_agent', 'browser_use', 'computer_use', 'image_generation'];
    const args = ['app-server', '--listen', 'stdio://', ...disabled.flatMap(name => ['-c', `features.${name}=false`])];
    this.child = this.spawnImpl(this.executable, args, {
      cwd: this.cwd, env: { ...process.env }, shell: false, windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // stderr can contain account or environment details. Drain it without storing or logging it.
    this.child.stderr.on('data', () => {});
    this.child.stdin.on('error', () => this.disconnect('Codex 连接已中断。'));
    this.child.once('error', () => this.disconnect('无法启动 Codex CLI。'));
    this.child.once('close', () => this.disconnect('Codex 后台已退出，请重新刷新。'));
    this.lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.lines.on('line', line => {
      if (line.length > 8 * 1024 * 1024) return this.close();
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id !== undefined && message.method) {
        // Never approve a tool, shell, login, or permission request from an unattended turn.
        this.send({ id: message.id, error: { code: -32601, message: 'Interactive tools are disabled.' } });
        return;
      }
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) {
          const error = new Error(`Codex 接口 ${pending.method} 返回错误（${message.error.code ?? '未知'}），请检查登录、网络或 CLI 版本。`);
          error.rpcCode = message.error.code;
          pending.reject(error);
        } else pending.resolve(message.result);
      } else if (message.method) this.emit('notification', message);
    });
    await this.request('initialize', { clientInfo: { name: 'codex_daylight', title: 'Codex Daylight', version: APP_VERSION } });
    this.send({ method: 'initialized', params: {} });
    return this;
  }

  send(message) {
    if (this.closed || !this.child?.stdin?.writable) throw new Error('Codex 尚未连接。');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}, timeoutMs = this.timeoutMs) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex 接口 ${method} 超时；不会自动重发模型请求。`));
        this.close();
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  disconnect(message) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pending.clear();
    this.emit('disconnected', message);
    this.child?.kill();
  }

  close() {
    this.disconnect('Codex 连接已关闭。');
    this.lines?.close();
    this.child?.stdin?.destroy();
    this.child?.kill();
  }

  async readAccount() {
    const response = await this.request('account/read', { refreshToken: false });
    // Deliberately discard email, account IDs and any other identity fields.
    return { isChatGPT: response?.account?.type === 'chatgpt', planType: response?.account?.planType ?? null };
  }

  async readLimits() {
    if (!(await this.readAccount()).isChatGPT) throw new Error('需要 Codex 的 ChatGPT 登录；API Key 不属于订阅五小时额度。请运行 codex login。');
    return this.request('account/rateLimits/read');
  }

  async selectModel(requested = '') {
    const models = [];
    let cursor;
    for (let page = 0; page < 10; page++) {
      const result = await this.request('model/list', { limit: 100, ...(cursor ? { cursor } : {}) });
      models.push(...(result?.data || []).filter(m => !m.hidden));
      cursor = result?.nextCursor;
      if (!cursor) break;
    }
    const selected = requested ? models.find(m => m.model === requested || m.id === requested) : models.find(m => m.isDefault) || models[0];
    if (!selected) throw new Error(requested ? '指定模型不在当前账号可用列表中，请清空模型设置或更换。' : '当前账号没有可用模型。');
    return selected;
  }

  async activate(model, { beforeSend = () => {} } = {}) {
    if (!(await this.readAccount()).isChatGPT) throw new Error('ChatGPT 登录状态已变化，本次未激活。');
    beforeSend();
    const started = await this.request('thread/start', {
      ephemeral: true, cwd: this.cwd, model: model.model, modelProvider: 'openai',
      approvalPolicy: 'untrusted', sandbox: 'read-only',
      baseInstructions: 'Reply with exactly OK. Do not call tools, inspect files, execute commands, or perform any other work.',
      developerInstructions: 'This is a single user-authorized scheduled availability check. Reply only OK without using any tools.',
      config: { web_search: 'disabled' },
    });
    const threadId = started?.thread?.id;
    if (!threadId) throw new Error('Codex 未返回临时会话。');
    let settle, timer;
    const completion = new Promise((resolve, reject) => {
      settle = { resolve, reject };
      timer = setTimeout(() => reject(new Error('激活等待超时，结果未确认；本次不会自动重试。')), 90000);
    });
    // Attach immediately so an early completion or failure cannot be missed.
    completion.catch(() => {});
    const onNotification = message => {
      const params = message.params || {};
      if (params.threadId !== threadId) return;
      if (message.method === 'turn/completed') {
        if (params.turn?.status === 'completed') settle.resolve();
        else settle.reject(new Error('激活未正常完成；请查看实际额度，本次不会自动重试。'));
      }
    };
    const onDisconnect = () => settle.reject(new Error('激活期间连接中断；结果未确认，本次不会自动重试。'));
    this.on('notification', onNotification);
    this.on('disconnected', onDisconnect);
    let turnId, completed = false;
    try {
      beforeSend();
      const efforts = (model.supportedReasoningEfforts || []).map(e => e.reasoningEffort);
      const effort = ['minimal', 'low'].find(e => efforts.includes(e)) || model.defaultReasoningEffort;
      const result = await this.request('turn/start', {
        threadId, input: [{ type: 'text', text: 'Reply only OK. Do not use any tools.' }],
        ...(effort ? { effort } : {}), serviceTier: 'default',
      });
      turnId = result?.turn?.id;
      await completion;
      completed = true;
      return { model: model.model };
    } finally {
      clearTimeout(timer);
      this.off('notification', onNotification);
      this.off('disconnected', onDisconnect);
      if (!completed && turnId && !this.closed) await this.request('turn/interrupt', { threadId, turnId }, 3000).catch(() => {});
      if (!this.closed) await this.request('thread/unsubscribe', { threadId }, 3000).catch(() => {});
    }
  }
}
