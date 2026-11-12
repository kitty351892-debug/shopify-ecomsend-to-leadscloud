import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

export function sanitizeUrl(raw) {
  try {
    const u = new URL(raw);
    u.username = ''; u.password = ''; u.search = '';
    u.hash = u.hash.split('?')[0];
    return u.href;
  } catch { return '[invalid URL]'; }
}

export function parseActivePort(text) {
  const [portText, browserPath] = text.trim().split(/\r?\n/);
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535 ||
      !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(browserPath || '')) {
    throw new Error('DevToolsActivePort 格式不正确');
  }
  return `ws://127.0.0.1:${port}${browserPath}`;
}

export function defaultProfileDir() {
  if (process.platform === 'win32') {
    if (!process.env.LOCALAPPDATA) throw new Error('缺少 LOCALAPPDATA，请指定 profileDir');
    return path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data');
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
  return path.join(os.homedir(), '.config', 'google-chrome');
}

export class CdpClient {
  constructor(socket, { timeoutMs = 20000 } = {}) {
    this.socket = socket; this.timeoutMs = timeoutMs; this.nextId = 1; this.pending = new Map();
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      const entry = this.pending.get(message.id);
      if (!entry) return;
      clearTimeout(entry.timer); this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(`CDP ${message.error.code}: ${message.error.message}`));
      else entry.resolve(message.result);
    });
    socket.addEventListener('close', () => this.failPending('Chrome 调试连接已关闭'));
    socket.addEventListener('error', () => this.failPending('Chrome 调试连接发生错误'));
  }

  failPending(message) {
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(new Error(message)); }
    this.pending.clear();
  }

  send(method, params = {}, sessionId) {
    if (this.socket.readyState !== 1) return Promise.reject(new Error('Chrome 调试连接未打开'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new Error(`CDP 超时: ${method}；操作结果需重新核实`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  async targets() { return (await this.send('Target.getTargets')).targetInfos; }
  async pages() {
    return (await this.targets()).filter(t => t.type === 'page').map(t => ({
      targetId: t.targetId, title: t.title, url: sanitizeUrl(t.url)
    }));
  }
  async attach(targetId) {
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    return new CdpPage(this, targetId, sessionId);
  }
  async newPage(url = 'about:blank') {
    const { targetId } = await this.send('Target.createTarget', { url, background: true });
    const page = await this.attach(targetId); page.owned = true; return page;
  }
  close() { this.socket.close(); } // 只断开，不发送 Browser.close
}

export class CdpPage {
  constructor(client, targetId, sessionId) {
    this.client = client; this.targetId = targetId; this.sessionId = sessionId; this.owned = false;
  }
  send(method, params = {}) { return this.client.send(method, params, this.sessionId); }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      // 不转储 exceptionDetails 中潜在的页面值和原始 URL。
      throw new Error(result.exceptionDetails.exception?.description?.split('\n')[0] || result.exceptionDetails.text);
    }
    return result.result?.value;
  }
  async navigate(url) {
    const result = await this.send('Page.navigate', { url });
    if (result.errorText) throw new Error(`页面加载失败: ${result.errorText}`);
  }
  reload() { return this.send('Page.reload'); }
  async waitFor(expression, { timeoutMs = 16000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    do {
      try { const value = await this.evaluate(expression); if (value) return value; }
      catch (error) { if (!/context|navigat|Cannot find|上下文/i.test(error.message)) throw error; }
      await delay(120);
    } while (Date.now() < deadline);
    throw new Error('页面状态等待超时；先重新观察，不直接重复保存');
  }
  async close() {
    if (!this.owned) throw new Error('不能关闭非本任务创建的标签');
    return this.client.send('Target.closeTarget', { targetId: this.targetId });
  }
}

export async function connectExisting({ profileDir = defaultProfileDir(), timeoutMs = 20000, WebSocketClass = globalThis.WebSocket } = {}) {
  if (!WebSocketClass) throw new Error('请使用 Node.js 22.15+（建议 24 LTS），此环境没有内置 WebSocket');
  let text;
  try { text = await fs.readFile(path.join(profileDir, 'DevToolsActivePort'), 'utf8'); }
  catch { throw new Error('未发现 DevToolsActivePort：请在当前 Chrome 启用远程调试，或核对 profileDir'); }
  const socket = new WebSocketClass(parseActivePort(text));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('Chrome 连接超时，请由用户检查调试连接许可')); }, timeoutMs);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Chrome 拒绝连接，请核对远程调试状态')); }, { once: true });
  });
  return new CdpClient(socket, { timeoutMs });
}
