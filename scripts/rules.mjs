export class PendingRecord extends Error {}

export const FIXED_FIELDS = Object.freeze({
  '来源一级': 'Retail站', '来源二级': 'Retail站-网站订阅', '电话': '',
  '跟进状态': '未处理', '行业一级': '其他', '行业二级': '',
  '重点标记': '否', '产品类型': '其他', '负责人': 'Kitty', '线索类型': '线索'
});

export const emailKey = value => String(value || '').trim().toLowerCase();
// 只去展示符号，不增加、删减、推断国家码，保留所有数字含前导零。
export function phoneKey(value) {
  const input = String(value || '').trim();
  if (!input || !/^[+\d\s().-]+$/.test(input)) return '';
  const digits = input.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 18 ? digits : '';
}

export function exactEvidence(record, text) {
  const emails = text.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  const phones = text.split(/[\r\n\t]/).map(t => t.trim())
    .filter(t => !/^\d{4}-\d{2}-\d{2}/.test(t)).map(phoneKey).filter(Boolean);
  return {
    email: !!emailKey(record.email) && emails.some(e => emailKey(e) === emailKey(record.email)),
    phone: !!phoneKey(record.phone) && phones.includes(phoneKey(record.phone))
  };
}

export function classifyDuplicate(record, checks = []) {
  const required = [];
  if (emailKey(record.email)) required.push(['邮箱', record.email.trim(), emailKey]);
  if (String(record.phone || '').trim()) required.push(['WhatsApp', record.phone, phoneKey]);
  if (!required.length) return { status: 'pending', reason: '邮箱和电话号码均缺失' };
  if (record.phone && !phoneKey(record.phone)) return { status: 'pending', reason: '原始号码无法可靠查重，不修改或补全号码' };
  const selected = [];
  for (const [field, query, key] of required) {
    const match = checks.filter(c => c.field === field && key(c.query) === key(query));
    if (match.length !== 1) return { status: 'pending', reason: `${field}查重证据缺失、重复或与当前查询值不一致` };
    selected.push(match[0]);
  }
  if (selected.some(c => !['clear', 'duplicate'].includes(c.kind))) return { status: 'pending', reason: '查重未完成或系统返回错误' };
  const evidence = selected.map(c => exactEvidence(record, c.text || ''));
  if (evidence.some(e => e.email || e.phone)) return { status: 'duplicate', reason: '查重结果中存在完整邮箱或完整数字号码精确匹配' };
  if (selected.some(c => c.kind === 'duplicate')) return { status: 'pending', reason: '系统只返回模糊匹配；完整邮箱和原始号码均未精确匹配，请人工核实' };
  return { status: 'clear', reason: '所有已有联系方式均已完成查重且未命中' };
}

export function makeLead(record, { countryOption, unknownOptions = [], fixed = {} } = {}) {
  if (!emailKey(record.email) && !String(record.phone || '').trim()) throw new PendingRecord('邮箱和电话号码均缺失');
  if (record.phone && !phoneKey(record.phone)) throw new PendingRecord('号码格式需确认，保留原值');
  const known = !!String(record.countryExplicit || '').trim();
  if (known && !String(record.countryEvidence || '').trim()) throw new PendingRecord('明确国家缺少订阅者资料证据');
  if (!countryOption) throw new PendingRecord('没有已核实的国家地区选项');
  if (known && countryOption !== record.countryExplicit) throw new PendingRecord('已核实国家与拟选国家不一致，先核对语言映射');
  if (!known && (!unknownOptions.includes(countryOption) || !['未知', '不详', '不明', 'Unknown', 'unknown'].includes(countryOption))) {
    throw new PendingRecord('资料没有国家，且没有已核实的系统未知选项');
  }
  for (const key of Object.keys(fixed)) if (!(key in FIXED_FIELDS)) throw new Error(`不支持的固定字段: ${key}`);
  const name = String(record.name || '').trim();
  return {
    ...FIXED_FIELDS, ...fixed,
    '线索名称': name && name !== '-' ? name : '未知',
    '电话': '', 'WhatsApp': record.phone || '', '邮箱': String(record.email || '').trim(),
    'Facebook 主页': record.facebook || '', '公司名称': record.company || '',
    '国家地区': countryOption, '客需备注': record.customerNeed || '未知'
  };
}

export function inDateRange(date, { from, toExclusive } = {}) {
  const day = String(date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('订阅日期缺失或格式变化');
  return (!from || day >= from) && (!toExclusive || day < toExclusive);
}
