# 供执行代理使用的运行说明

## 连接当前 Chrome

用户在 Chrome 144+ 的 `chrome://inspect/#remote-debugging` 开启后，通过 `DevToolsActivePort` 中记录的端口及路径连接。端口不一定是 9222。用户处理 Chrome 弹出的连接许可。不要关闭浏览器或复制个人配置来接管登录。

在普通 Node.js 进程中执行；部分工具沙箱不提供全局 WebSocket，此时使用已安装的本机 Node 运行 `.mjs`，不要因此退回鼠标操作或临时安装 npm 包。

```powershell
node scripts/probe.mjs
```

脚本只输出去除查询参数后的页面 URL。指定其他配置根目录时：

```powershell
node scripts/probe.mjs --profile-dir "C:\path\to\Chrome User Data"
```

提供的是当前 Chrome 的**配置根目录**，不是 `Default` 子目录。脚本不读取浏览器数据库。如果端口未启用，先让用户检查当前窗口的开关；不要继续向同一失败端口反复请求。

## 在代理脚本中组合辅助库

这些是可组合的 UI 辅助库，不是无需页面校准的无人值守全站爬虫。用当前任务私有目录保存运行脚本；不要将真实输入写入技能目录。下面的相对 import 示例假设从技能根目录运行；任务脚本在其他目录时改用该技能实际位置的绝对模块路径。

```javascript
import { connectExisting } from './scripts/cdp.mjs';
import { collectAll, readDetail, CrmForm } from './scripts/ui.mjs';
import { makeLead, classifyDuplicate } from './scripts/rules.mjs';
import { SaveJournal } from './scripts/journal.mjs';

const chrome = await connectExisting();
const pages = await chrome.targets(); // 不将完整原始 URL 直接写入日志
// 选择 URL 为目标店铺 subscribers 的父页面；其 parentId 对应的
// app.ecomsend.com/subscribers iframe 才是本任务来源。不能选另一店铺。
const source = await chrome.attach(sourceTargetId);
const collected = await collectAll(source, {
  from: '2026-10-01', toExclusive: '2026-12-01',
  onPage: async progress => { /* 立即保存本机读取断点 */ }
});
```

`collectAll` 从首页遍历至末页后按日期过滤；若页内结构、总数或页间变化无法校验会报错，不开始录入。日期例子只说明参数格式，不是默认范围。

CRM 创建路由从当前真实页面/iframe发现；如没有，先在询盘云界面打开一次“新建线索”，观察其 iframe URL。不要复制其他租户的对象 ID。`CrmForm.open(chrome, observedCreateUrl)` 在当前浏览器创建本任务独占的后台标签，不重载用户的未保存草稿。

```javascript
const form = await CrmForm.open(chrome, observedCreateUrl);
const journal = new SaveJournal(privateRunDirectory);
await journal.load();

const checks = await form.check(record); // 邮箱和号码分别查重，返回实际文本
const decision = classifyDuplicate(record, checks);
// duplicate：记为重复；pending：记录具体原因；clear：再读必要详情。
const detail = await readDetail(detailPage, record);
// 从真实资料和现有国家下拉确定 countryOption；makeLead 不会猜国家。
const payload = makeLead({ ...record,
  countryExplicit: confirmedCountry,
  countryEvidence: observedCountryText,
  customerNeed: confirmedCustomerNeed,
  company: confirmedCompany,
  facebook: explicitFacebookUrl
}, { countryOption });

// 默认只填表和校验，不保存。
const review = await form.create(record, payload, { checks, journal });
// 当前用户已经授权录入时，直接用 commit:true 执行，不重复索要许可。
// await form.create(record, payload, { checks, journal, commit: true });
```

这里的变量应由代理根据实际资料提供；`readDetail` 返回证据，不会把任意非空备注自动认定为需求。`makeLead` 遇到缺少国家且没有真实未知选项、缺少有效联系人等情况会拒绝构造。

## 保存、续跑与超时

`form.create` 会逐项核验 17 个字段，并在点击保存前写入 `save-intent`。成功只认本次新出现的成功消息。异常保留 `uncertain`；按钮恢复、对话框消失或前次查重成功都不能代替保存证据。

同一日志中 `created/duplicate` 不再提交；`saving/uncertain` 不可直接重试。按原邮箱和号码查询 CRM 新记录、核对创建时间与字段后，用 `journal.resolve` 记录查询证据。确认为未创建，必须保留所有已有联系方式均已精确查询且无匹配的证据，才允许解除阻塞。

循环处理下一条前，调用 `await form.reset()` 重建本任务独占的空白表单，再执行该条 `check/create`；不要直接复用上一条保存后关闭的对话框。把每条 `checks` 与来源记录一起写入私有断点，不能把别人的查询证据传给当前记录。

可以把每个阶段做成一个短脚本或常驻 Node 进程。每次工具调用约处理 3—4 条、控制在 45 秒左右；逐条落盘。长批次先持久化再输出，避免工具超时后只有内存里的断点丢失。

详情读取可用最多三个独立后台标签并行；表单操作串行。正常停止时关闭 `CrmForm.close()` 及自己建立的详情标签，调用 `chrome.close()` 只断开 CDP，不关闭用户浏览器。

## 版本变化与故障定位

- EcomSend 新页面使用 `s-table` 和 Shadow DOM 内的前后页按钮；详情链接在行内 `a`，日期在 `data-id="subscribed_at"`。
- 询盘云表单按 `.xhl-el-form-item` 中精确标签定位，输入框通过原生 `value` setter 和 input/change 事件填写，不访问 Vue 私有状态或隐藏接口。
- 下拉按当前 wrapper 的 `aria-describedby` 找自己的弹层。国家/产品可能是虚拟列表；先输入精确选项过滤，再选择并核验。
- Shopify 详情正文的 `innerText` 可能遗漏 Web Component 插槽。读有明确 heading 的资料卡及 `span[data-key]`；等待地址资料实际加载，不把骨架屏当作缺失资料。适配器不识别当前结构时保留问题供代理校准。
- 查重界面可能只匹配邮箱域名或部分号码；以完整值校验。报错或模糊命中进入待确认，不能作为“无重复”。
- 不采集页面查询参数、登录凭据及扩展后台；不把 `Target.getTargets` 的原始全部结果打印到聊天或提交 Git。

## 离线验证

```powershell
node --test scripts/tests/core.test.mjs
```

验证完整邮箱/号码匹配、未知国家、字段原值、保存意图与续跑约束、CDP 请求应答及隐私清理；不接触生产 CRM。不通过真实写入来测试新封装。
