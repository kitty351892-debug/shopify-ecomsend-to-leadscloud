import { setTimeout as delay } from 'node:timers/promises';
import { classifyDuplicate, inDateRange } from './rules.mjs';

const ROWS = `(()=>{const rows=[...document.querySelectorAll('s-table-row[data-row-index]')];
return rows.map(r=>{const get=k=>r.querySelector('[data-id="'+k+'"]')?.innerText.trim()||'';
return {email:get('email'),phone:get('phone'),name:get('customer_name'),location:get('location'),date:get('subscribed_at'),url:r.querySelector('a')?.href||''};});})()`;
const rowKey = r => JSON.stringify([r.url, r.email, r.phone, r.date, r.name]);

async function pagination(page, direction, click = false) {
  const label = direction === 'next' ? '前往下一页' : '前往上一页';
  return page.evaluate(`(()=>{const table=document.querySelector('s-table');
    const b=table?.shadowRoot?.querySelector('button[aria-label=${JSON.stringify(label)}]');
    if(!b)throw Error('当前分页结构不受支持，请先检查页面');
    const disabled=b.disabled;if(${click}&&!disabled)b.click();return {disabled};})()`);
}

export async function collectAll(page, { from, toExclusive, expectedTotal, maxPages = 1000, onPage = async () => {} } = {}) {
  for (const d of [from, toExclusive]) if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error('日期应为 YYYY-MM-DD');
  if (from && toExclusive && from >= toExclusive) throw new Error('日期范围为空或倒置');
  await page.waitFor(`document.querySelector('s-table')&&(document.querySelectorAll('s-table-row[data-row-index]').length||/全部\\s*0(?:\\D|$)/.test(document.body.innerText))`);
  const totalExpression = `(()=>{const m=document.body.innerText.match(/全部\\s*(\\d+)/);return m?Number(m[1]):null;})()`;
  const initialTotal = await page.evaluate(totalExpression);
  if (initialTotal === 0 && (await page.evaluate(ROWS)).length === 0) {
    if (expectedTotal !== undefined && expectedTotal !== 0) throw new Error('空列表与指定总数不符');
    return { total: 0, included: [], excluded: 0 };
  }
  // 恢复到首页；用户可能停在上次查看的中间页。
  for (let n = 0; !(await pagination(page, 'previous')).disabled; n++) {
    if (n >= maxPages) throw new Error('回到首页超过分页上限');
    const prior = JSON.stringify(await page.evaluate(ROWS));
    await pagination(page, 'previous', true);
    await page.waitFor(`document.querySelectorAll('s-table-row[data-row-index]').length&&JSON.stringify(${ROWS})!==${JSON.stringify(prior)}`);
  }
  const observedTotal = await page.evaluate(totalExpression);
  const all = [], seenPages = new Set();
  for (let n = 1; n <= maxPages; n++) {
    const rows = await page.evaluate(ROWS);
    if (!rows.length) throw new Error('列表为空或正在加载，不能认作已读完');
    const signature = JSON.stringify(rows.map(rowKey));
    if (seenPages.has(signature)) throw new Error('分页未前进或出现循环');
    seenPages.add(signature); all.push(...rows);
    await onPage({ page: n, read: all.length, rows });
    if ((await pagination(page, 'next')).disabled) {
      const total = expectedTotal ?? observedTotal;
      if (total !== null && total !== undefined && total !== all.length) throw new Error(`分页数量不符：页面/指定总数 ${total}，实际读取 ${all.length}`);
      return { total: all.length, included: all.filter(r => inDateRange(r.date, { from, toExclusive })), excluded: all.filter(r => !inDateRange(r.date, { from, toExclusive })).length };
    }
    const before = JSON.stringify(rows);
    await pagination(page, 'next', true);
    await page.waitFor(`document.querySelectorAll('s-table-row[data-row-index]').length&&JSON.stringify(${ROWS})!==${JSON.stringify(before)}`);
  }
  throw new Error('超过分页上限，来源尚未读完');
}

export async function readDetail(page, record) {
  if (!/^https:\/\/admin\.shopify\.com\/store\/[^/]+\/customers\/\d+/.test(record.url || '')) throw new Error('缺少已观察到的客户详情链接');
  await page.navigate(record.url);
  const result = await page.waitFor(`(()=>{
    const contact=document.querySelector('s-internal-section[heading="联系信息"]');
    const address=document.querySelector('s-internal-section[heading="默认地址"]');
    const notes=document.querySelector('s-internal-section[heading="备注"] .Polaris-BlockStack');
    const contactMatches=${json(String(record.email || '').trim())}
      ?contact?.textContent.toLowerCase().includes(${json(String(record.email || '').trim().toLowerCase())})
      :contact?.querySelector('bdi')?.textContent.replace(/\\D/g,'')===${json(String(record.phone || '').replace(/\D/g, ''))};
    if(!contact||!notes||!address?.textContent.trim()||!contactMatches)return null;
    return {heading:document.querySelector('s-internal-page')?.getAttribute('heading'),contact:contact.textContent,
      address:[...address.querySelectorAll('span[data-key]')].map(e=>e.textContent),notes:notes.textContent};
  })()`, { timeoutMs: 18000 });
  return { ...result, needsReview: result.notes !== '无' || result.address.length > 2 };
}

function browserHelpers() {
  const u = window.subscriberIntakeUI = {};
  u.pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  u.visible = e => e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  u.field = label => {
    const fields = [...document.querySelectorAll('.xhl-el-form-item')].filter(f => f.querySelector('label')?.textContent.trim() === label);
    if (fields.length !== 1) throw Error('字段不唯一或不存在: ' + label);
    return fields[0];
  };
  u.fill = (label, value) => {
    const input = u.field(label).querySelector('input,textarea');
    if (!input || input.disabled) throw Error('输入框不可编辑: ' + label);
    input.focus();
    const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  u.duplicateDialog = () => [...document.querySelectorAll('.xhl-el-overlay-dialog')].find(d => u.visible(d) && d.innerText.startsWith('以下数据可能重复'));
  u.closeDuplicate = async () => {
    const dialog = u.duplicateDialog();
    if (!dialog) return;
    const cancel = [...dialog.querySelectorAll('button')].find(b => u.visible(b) && b.innerText.trim() === '取消');
    if (!cancel) throw Error('不能安全关闭查重结果');
    cancel.click();
    for (let n = 0; n < 50 && u.duplicateDialog(); n++) await u.pause(50);
    if (u.duplicateDialog()) throw Error('查重结果没有关闭');
  };
  u.check = async (field, query) => {
    await u.closeDuplicate();
    u.fill(field, query); await u.pause(50);
    const before = new Set(document.querySelectorAll('.xhl-el-message'));
    const button = u.field(field).querySelector('button');
    if (!button || button.disabled) throw Error('查重按钮不可用: ' + field);
    button.click(); await u.pause(80);
    for (let n = 0; n < 150; n++) {
      const d = u.duplicateDialog();
      const messages = [...document.querySelectorAll('.xhl-el-message')].filter(m => !before.has(m)).map(m => m.innerText);
      if (!button.disabled && d) { const text = d.innerText; await u.closeDuplicate(); return { field, query, kind: 'duplicate', text }; }
      if (!button.disabled && messages.length) return { field, query, kind: messages.some(m => m.includes('操作成功')) ? 'clear' : 'error', text: messages.join('\n') };
      await u.pause(100);
    }
    throw Error('查重结果未确认: ' + field);
  };
  u.select = async (label, value) => {
    const f = u.field(label), input = f.querySelector('input'), wrapper = f.querySelector('.xhl-el-select__wrapper');
    if (!input || !wrapper || input.disabled) throw Error('下拉框不可编辑: ' + label);
    if (input.getAttribute('aria-expanded') !== 'true') input.click();
    u.fill(label, value); await u.pause(80);
    const popId = wrapper.getAttribute('aria-describedby');
    if (!popId) throw Error('下拉框缺少当前弹层标识: ' + label);
    for (let n = 0; n < 70; n++) {
      const pop = document.getElementById(popId);
      const options = pop ? [...pop.querySelectorAll('li,[role="option"]')].filter(e => u.visible(e) && e.innerText.trim() === value) : [];
      if (options.length > 1) throw Error('下拉选项不唯一: ' + label + ' ' + value);
      if (options.length === 1) {
        options[0].click();
        for (let j = 0; j < 30; j++) {
          await u.pause(50);
          if (options[0].getAttribute('aria-selected') === 'true' && input.getAttribute('aria-expanded') !== 'true') return;
        }
        throw Error('未真正选中下拉选项: ' + label);
      }
      await u.pause(100);
    }
    throw Error('指定下拉选项不存在: ' + label + ' ' + value);
  };
  u.snapshot = () => Object.fromEntries([...document.querySelectorAll('.xhl-el-form-item')].map(f => {
    const label = f.querySelector('label')?.textContent.trim();
    const input = f.querySelector('input,textarea');
    const checked = f.querySelector('input[type="radio"]:checked');
    let value = input?.getAttribute('role') === 'combobox' ? f.innerText.trim().split(/\n+/).at(-1) : input?.value;
    if (label === '重点标记') value = checked?.value === '0' ? '否' : checked?.value === '1' ? '是' : undefined;
    if (label === '行业二级' && value === '请选择行业二级') value = '';
    return [label, value];
  }));
  u.save = async () => {
    const before = new Set(document.querySelectorAll('.xhl-el-message'));
    const buttons = [...document.querySelectorAll('.xhl-el-dialog__footer button')].filter(b => u.visible(b) && b.innerText.trim() === '保存');
    if (buttons.length !== 1 || buttons[0].disabled) throw Error('保存按钮不唯一或不可用');
    buttons[0].click(); await u.pause(80);
    for (let n = 0; n < 160; n++) {
      const messages = [...document.querySelectorAll('.xhl-el-message')].filter(m => !before.has(m)).map(m => m.innerText);
      if (messages.length) return { kind: 'toast', text: messages.join('\n'), success: messages.some(m => m.includes('操作成功')) };
      if (u.duplicateDialog()) return { success: false, text: '保存时出现重复提示，请先核对是否创建' };
      const errors = [...document.querySelectorAll('.xhl-el-form-item__error')].filter(u.visible).map(e => e.innerText);
      if (errors.length) return { success: false, text: errors.join('\n') };
      await u.pause(100);
    }
    return { success: false, text: '未得到本次保存成功证据' };
  };
}

export const UI_BOOTSTRAP = `(${browserHelpers.toString()})()`;
const json = JSON.stringify;
const SELECT_FIELDS = ['来源一级', '来源二级', '国家地区', '跟进状态', '行业一级', '行业二级', '产品类型'];

export class CrmForm {
  constructor(page) { this.page = page; this.initialized = false; }
  static async open(chrome, observedCreateUrl) {
    const url = new URL(observedCreateUrl);
    if (url.origin !== 'https://crm.leadscloud.com' || !url.hash.startsWith('#/crm/createModal?')) throw new Error('需要当前租户真实观察到的询盘云创建页 URL');
    const form = new CrmForm(await chrome.newPage(url.href));
    await form.ready(); return form;
  }
  async ready() {
    await this.page.waitFor(`(()=>{const i=document.querySelector('input[placeholder="请输入线索名称"]');return i&&i.checkVisibility()&&document.querySelectorAll('.xhl-el-form-item').length>=17;})()`);
    await this.page.evaluate(UI_BOOTSTRAP); this.initialized = true;
  }
  async reset() {
    if (!this.page.owned) throw new Error('不重载用户的现有草稿');
    await this.page.reload(); this.initialized = false;
    // 旧页面即使尚未销毁也必须先等空白表单，不能复用上一条内容。
    await this.page.waitFor(`document.querySelector('input[placeholder="请输入线索名称"]')?.value===''&&document.querySelector('input[placeholder="请输入线索名称"]')?.checkVisibility()`);
    await this.ready();
  }
  async check(record) {
    if (!this.initialized) await this.ready();
    const results = [];
    // 清空不属于当前记录的查重值；这是本任务独占的临时表单。
    if (!this.page.owned) throw new Error('查重应使用本任务独占表单，避免覆盖用户草稿');
    await this.page.evaluate(`subscriberIntakeUI.fill('邮箱',${json(String(record.email || '').trim())});subscriberIntakeUI.fill('WhatsApp',${json(record.phone || '')});`);
    if (String(record.email || '').trim()) results.push(await this.page.evaluate(`subscriberIntakeUI.check('邮箱',${json(record.email.trim())})`));
    if (record.phone) results.push(await this.page.evaluate(`subscriberIntakeUI.check('WhatsApp',${json(record.phone)})`));
    return results;
  }
  async create(record, payload, { checks = [], journal, commit = false } = {}) {
    if (!this.page.owned) throw new Error('不允许改写用户现有草稿');
    if (classifyDuplicate(record, checks).status !== 'clear') throw new Error('必须先取得本条所有联系方式的明确查重结果');
    if (journal && ['created', 'duplicate', 'saving', 'uncertain'].includes(journal.state(record)?.status)) throw new Error('日志阻止重复或不确定提交');
    if (!this.initialized) await this.ready();
    for (const [label, value] of Object.entries(payload)) {
      if (SELECT_FIELDS.includes(label)) {
        if (value) await this.page.evaluate(`subscriberIntakeUI.select(${json(label)},${json(value)})`);
      } else if (!['重点标记', '负责人', '线索类型'].includes(label)) {
        await this.page.evaluate(`subscriberIntakeUI.fill(${json(label)},${json(value)})`);
      }
    }
    const snapshot = await this.page.evaluate('subscriberIntakeUI.snapshot()');
    for (const [label, value] of Object.entries(payload)) if (snapshot[label] !== value) throw new Error(`表单核验不符: ${label}；未保存`);
    if (!commit) return { dryRun: true, snapshot };
    if (!journal) throw new Error('保存前必须提供私有持久化日志');
    await journal.intent(record, payload);
    try {
      const evidence = await this.page.evaluate('subscriberIntakeUI.save()');
      if (!evidence.success) { await journal.uncertain(record, evidence.text); return { status: 'uncertain', evidence }; }
      await journal.complete(record, evidence); this.initialized = false;
      return { status: 'created', evidence };
    } catch (error) {
      await journal.uncertain(record, error.message); throw error;
    }
  }
  close() { return this.page.close(); }
}
