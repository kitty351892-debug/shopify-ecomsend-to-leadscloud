import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { CdpClient, parseActivePort, sanitizeUrl } from '../cdp.mjs';
import { makeLead, classifyDuplicate, phoneKey, inDateRange } from '../rules.mjs';
import { SaveJournal } from '../journal.mjs';
import { UI_BOOTSTRAP } from '../ui.mjs';

// 全部为合成资料，不来自真实客户。
const person = { email: ' Person@sample.invalid ', phone: '+1 (202) 555-0100', name: '', url: 'https://example.invalid/customer/1' };
const clear = [
  { field: '邮箱', query: person.email.trim(), kind: 'clear', text: '操作成功' },
  { field: 'WhatsApp', query: person.phone, kind: 'clear', text: '操作成功' }
];

test('完整邮箱忽略大小写，不能仅按邮箱域名认定重复', () => {
  assert.equal(classifyDuplicate(person, [{ ...clear[0], kind: 'duplicate', text: 'person@sample.invalid' }, clear[1]]).status, 'duplicate');
  assert.equal(classifyDuplicate(person, [{ ...clear[0], kind: 'duplicate', text: 'another@sample.invalid' }, clear[1]]).status, 'pending');
  assert.equal(classifyDuplicate(person, clear).status, 'clear');
});

test('号码只去展示符号，不补国际码或比较后几位', () => {
  assert.equal(phoneKey(person.phone), '12025550100');
  assert.equal(classifyDuplicate(person, [clear[0], { ...clear[1], kind: 'duplicate', text: '12025550100' }]).status, 'duplicate');
  const raw = { ...person, phone: '+2030000000' };
  const partial = [clear[0], { field: 'WhatsApp', query: raw.phone, kind: 'duplicate', text: '12030000000' }];
  assert.equal(classifyDuplicate(raw, partial).status, 'pending');
  assert.notEqual(phoneKey('0012025550100'), phoneKey('+12025550100'));
});

test('错误、缺失和串条查重证据不允许建档', () => {
  assert.equal(classifyDuplicate(person, [clear[0]]).status, 'pending');
  assert.equal(classifyDuplicate(person, [clear[0], { ...clear[1], query: '+12025550101' }]).status, 'pending');
  assert.equal(classifyDuplicate(person, [clear[0], { ...clear[1], kind: 'error' }]).status, 'pending');
  assert.equal(classifyDuplicate({ email: '', phone: '' }, []).status, 'pending');
});

test('原始号码与邮箱、未知姓名/需求和空电话遵守字段规则', () => {
  const lead = makeLead({ ...person, countryExplicit: '美国', countryEvidence: 'United States' }, { countryOption: '美国' });
  assert.equal(Object.keys(lead).length, 17);
  assert.equal(lead['线索名称'], '未知'); assert.equal(lead['客需备注'], '未知');
  assert.equal(lead['邮箱'], 'Person@sample.invalid'); assert.equal(lead['WhatsApp'], person.phone);
  assert.equal(lead['电话'], ''); assert.equal(lead['负责人'], 'Kitty');
  assert.equal(lead['公司名称'], ''); assert.equal(lead['行业二级'], '');
});

test('国家不能从电话或邮箱猜测，其他不能替代未知', () => {
  assert.throws(() => makeLead(person, { countryOption: '美国' }), /国家/);
  assert.throws(() => makeLead(person, { countryOption: '其他', unknownOptions: ['其他'] }), /未知/);
  assert.equal(makeLead(person, { countryOption: '未知', unknownOptions: ['未知'] })['国家地区'], '未知');
  assert.throws(() => makeLead({ ...person, countryExplicit: '印度', countryEvidence: 'India' }, { countryOption: '美国' }), /不一致/);
});

test('日期范围包含起日、不包含结束日，不依赖主机时区', () => {
  const range = { from: '2026-10-01', toExclusive: '2026-12-01' };
  assert.equal(inDateRange('2026-10-01 00:00', range), true);
  assert.equal(inDateRange('2026-11-30 23:59', range), true);
  assert.equal(inDateRange('2026-12-01 00:00', range), false);
  assert.throws(() => inDateRange('', range), /日期/);
});

test('连接只从合法本机 DevToolsActivePort 发现，日志 URL 去除认证参数', () => {
  assert.equal(parseActivePort('9222\n/devtools/browser/abc-123\n'), 'ws://127.0.0.1:9222/devtools/browser/abc-123');
  for (const bad of ['0\n/devtools/browser/a', '65536\n/devtools/browser/a', '9222\nws://remote.invalid/x']) assert.throws(() => parseActivePort(bad));
  const safe = sanitizeUrl('https://example.invalid/path?id_token=secret#/crm/createModal?token=secret');
  assert.equal(safe.includes('secret'), false); assert.equal(safe, 'https://example.invalid/path#/crm/createModal');
});

class FakeSocket extends EventTarget {
  readyState = 1;
  sent = [];
  send(text) { this.sent.push(JSON.parse(text)); }
  reply(data) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) })); }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
}

test('CDP 并发请求按 ID 配对，关闭连接拒绝未完成操作', async () => {
  const socket = new FakeSocket(), client = new CdpClient(socket, { timeoutMs: 1000 });
  const first = client.send('one'), second = client.send('two');
  socket.reply({ id: 2, result: { number: 2 } }); socket.reply({ id: 1, result: { number: 1 } });
  assert.deepEqual(await first, { number: 1 }); assert.deepEqual(await second, { number: 2 });
  const pending = client.send('pending'); client.close(); await assert.rejects(pending, /关闭/);
});

test('保存意图重载后阻止再次提交，只有核验无记录才能解锁', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'subscriber-intake-test-'));
  try {
    const journal = await new SaveJournal(dir).load();
    await journal.intent(person, { '邮箱': person.email.trim() });
    const resumed = await new SaveJournal(dir).load();
    await assert.rejects(resumed.intent(person, {}), /禁止再次提交/);
    await assert.rejects(resumed.resolve(person, { status: 'not-created', evidence: { kind: 'lookup', text: '未查到', checkedEmail: true, exactMatches: 0 } }), /所有已有联系方式/);
    await resumed.resolve(person, { status: 'not-created', evidence: { kind: 'lookup', text: '邮箱和号码均无精确记录', checkedEmail: true, checkedPhone: true, exactMatches: 0 } });
    await resumed.intent(person, {});
    await assert.rejects(resumed.complete(person, { success: true }), /保存证据/);
    await resumed.complete(person, { success: true, kind: 'toast', text: '本次操作成功' });
    await assert.rejects(resumed.intent(person, {}), /禁止再次提交/);
    assert.equal((await new SaveJournal(dir).load()).state(person).status, 'created');
  } finally {
    const actual = path.resolve(dir), tempRoot = path.resolve(os.tmpdir()) + path.sep;
    assert.ok(actual.startsWith(tempRoot) && path.basename(actual).startsWith('subscriber-intake-test-'));
    await fs.rm(actual, { recursive: true });
  }
});

test('下拉只选择当前弹层的精确选项，忽略同名旧弹层', async () => {
  let selected = false, staleClicks = 0;
  class Input {
    _value = ''; expanded = false;
    get value() { return this._value; } set value(v) { this._value = v; }
    focus() {} dispatchEvent() {}
    click() { this.expanded = true; }
    getAttribute(name) { return name === 'aria-expanded' ? String(this.expanded) : null; }
  }
  const input = new Input();
  const option = { checkVisibility: () => true, innerText: '其他', getAttribute: () => String(selected), click() { selected = true; input.expanded = false; } };
  const stale = { checkVisibility: () => false, innerText: '其他', click() { staleClicks++; } };
  const field = { querySelector(selector) { if (selector === 'label') return { textContent: '产品类型' }; if (selector === 'input' || selector === 'input,textarea') return input; return { getAttribute: () => 'current-popper' }; } };
  const document = { querySelectorAll: selector => selector === '.xhl-el-form-item' ? [field] : [stale], getElementById: id => id === 'current-popper' ? { querySelectorAll: () => [option] } : null };
  const context = { window: {}, document, HTMLInputElement: Input, HTMLTextAreaElement: Input, Event, setTimeout };
  vm.runInNewContext(UI_BOOTSTRAP, context);
  context.window.subscriberIntakeUI.pause = async () => {};
  await context.window.subscriberIntakeUI.select('产品类型', '其他');
  assert.equal(selected, true); assert.equal(staleClicks, 0);
});

test('前次查重成功提示不能作为本次保存成功', async () => {
  const oldToast = { innerText: '操作成功' };
  const saveButton = { innerText: '保存', disabled: false, click() {}, checkVisibility: () => true };
  const document = { querySelectorAll(selector) {
    if (selector === '.xhl-el-message') return [oldToast];
    if (selector === '.xhl-el-dialog__footer button') return [saveButton];
    return [];
  } };
  const context = { window: {}, document, setTimeout };
  vm.runInNewContext(UI_BOOTSTRAP, context);
  context.window.subscriberIntakeUI.pause = async () => {};
  const result = await context.window.subscriberIntakeUI.save();
  assert.equal(result.success, false);
});
