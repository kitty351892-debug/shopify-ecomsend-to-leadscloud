import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function recordKey(record) {
  const key = record.sourceId || record.url || `${String(record.email || '').trim().toLowerCase()}\n${record.phone || ''}`;
  if (!key.replace(/\s/g, '')) throw new Error('记录缺少稳定标识');
  return createHash('sha256').update(key).digest('hex');
}

export class SaveJournal {
  constructor(runDir) { this.runDir = path.resolve(runDir); this.file = path.join(this.runDir, 'events.jsonl'); this.states = new Map(); this.loaded = false; }
  async load() {
    await fs.mkdir(this.runDir, { recursive: true });
    let text = '';
    try { text = await fs.readFile(this.file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.states.clear();
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i]) continue;
      // 未完成的末行也不能忽略：可能正是已经点击保存的意图。
      let event; try { event = JSON.parse(lines[i]); } catch { throw new Error(`日志第 ${i + 1} 行损坏，停止提交并核对 CRM`); }
      if (!event.key || !event.status) throw new Error('日志事件格式错误');
      this.states.set(event.key, event);
    }
    this.loaded = true; return this;
  }
  state(record) { if (!this.loaded) throw new Error('先加载日志'); return this.states.get(recordKey(record)); }
  async append(record, status, details = {}) {
    if (!this.loaded) throw new Error('先加载日志');
    const event = { key: recordKey(record), time: new Date().toISOString(), status, ...details };
    // fsync 在点击外部保存前把意图真正持久化；不只保存在代理内存。
    const handle = await fs.open(this.file, 'a');
    try { await handle.writeFile(JSON.stringify(event) + '\n'); await handle.sync(); } finally { await handle.close(); }
    this.states.set(event.key, event); return event;
  }
  async intent(record, payload) {
    const prior = this.state(record);
    if (prior && ['saving', 'uncertain', 'created', 'duplicate'].includes(prior.status)) throw new Error(`记录已为 ${prior.status}；禁止再次提交，先核对 CRM`);
    return this.append(record, 'saving', { email: record.email || '', phone: record.phone || '', payload });
  }
  async complete(record, evidence) {
    if (this.state(record)?.status !== 'saving') throw new Error('没有对应保存意图');
    if (!evidence?.success || !['toast', 'lookup'].includes(evidence.kind) || !evidence.text) throw new Error('缺少明确保存证据');
    return this.append(record, 'created', { evidence });
  }
  uncertain(record, reason) { return this.append(record, 'uncertain', { reason, email: record.email || '', phone: record.phone || '' }); }
  async resolve(record, { status, evidence } = {}) {
    if (!['saving', 'uncertain'].includes(this.state(record)?.status)) throw new Error('只有结果不明的提交需要核对解锁');
    if (evidence?.kind !== 'lookup' || !evidence.text) throw new Error('恢复必须提供 CRM 查询证据');
    if (!['created', 'duplicate', 'not-created'].includes(status)) throw new Error('不支持的恢复状态');
    if (status !== 'not-created' && !(evidence.exactMatches > 0)) throw new Error('确认已有记录必须有精确查询命中');
    if (status === 'not-created' && ((record.email && !evidence.checkedEmail) || (record.phone && !evidence.checkedPhone) || evidence.exactMatches !== 0)) {
      throw new Error('必须核对所有已有联系方式，且均无精确匹配，才能解锁重试');
    }
    return this.append(record, status, { evidence });
  }
}
