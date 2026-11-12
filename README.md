# Shopify EcomSend 订阅者录入询盘云

一个可重复使用的 Codex Skill：读取 Shopify EcomSend（现名 CWILL / SendWILL）订阅者，按真实资料与固定字段规则，逐条查重并创建询盘云线索。

版本：**1.0.0-pilot**。优先直连已经打开、已经登录的 Chrome，保留原有登录状态；读取可在后台执行，查重及保存串行完成。

## 安装与使用

将本仓库完整目录放到 Codex 技能目录，目录名保持为 `shopify-ecomsend-to-leadscloud`：

```text
Windows: %USERPROFILE%\.codex\skills\shopify-ecomsend-to-leadscloud\SKILL.md
macOS / Linux: ~/.codex/skills/shopify-ecomsend-to-leadscloud/SKILL.md
```

如果设置了 `CODEX_HOME`，使用该目录下的 `skills/`。已有同名技能时先比较并备份自己的修改，再更新。开启新聊天后使用：

> 使用 $shopify-ecomsend-to-leadscloud，处理我 Shopify 店铺 2026 年 10 月和 11 月的 EcomSend 订阅者，录入询盘云，负责人 Kitty。按默认字段规则执行，完成后报告检查、新建、重复和待确认数量。

也可以指定日期或操作范围：

- “只检查最近 7 天的订阅者并查重，先不保存。”
- “将所有订阅者按规则录入询盘云，不发送通知。”
- “从上次本机断点继续，先核实结果不明的保存，避免重复。”

用户明确要求录入即授权该范围内的逐条创建，无须再逐条确认。只读检查、安装技能、制作报告均不授权创建线索。年份、日期范围与店铺以本次任务为准，没有预设为 2026 年或某一个月。

## 直接连接当前 Chrome

1. 确认当前 Chrome 已登录目标 Shopify 店铺和询盘云。
2. 在**同一个浏览器**地址栏输入 `chrome://inspect/#remote-debugging`。
3. 勾选 **Enable remote debugging / 启用远程调试**。
4. Codex 发起连接时，由你处理 Chrome 的允许连接提示。

Chrome 144+ 支持此流程，无需关闭当前窗口、重新登录或复制个人配置。端口从 `DevToolsActivePort` 自动发现，不要求固定 9222。参考 [Chrome 官方配置说明](https://developer.chrome.com/docs/devtools/agents/get-started/configuration)。

需要本机 **Node.js 22.15+，建议 24 LTS**，无需 npm 安装依赖。代理可以先执行只读探测：

```powershell
node scripts/probe.mjs
```

连接其他浏览器配置根目录时：

```powershell
node scripts/probe.mjs --profile-dir "C:\path\to\Chrome User Data"
```

只指定该浏览器实际使用的配置根目录；工具不会读取 Cookie、密码或登录数据库。遇到登录、验证码或连接授权由你完成。执行环境拒绝某项操作时，应报告阻塞，不能绕过。

## 处理规则

| 项目 | 行为 |
|---|---|
| 分页和日期 | 从首页读取到末页，核对总数后按页面日期筛选；不只处理当前页 |
| 姓名和需求 | 只采用真实姓名和明确需求；缺失填“未知”，不从邮箱或订阅行为推测 |
| 电话和 WhatsApp | 电话留空；原始号码填 WhatsApp，保留区号，不自行补全 |
| 邮箱 | 只去首尾空格，保留原始邮箱 |
| 国家地区 | 采用资料明确显示的国家/地区；缺失时仅选真实存在的“未知”或同义选项 |
| 查重 | 邮箱和有值的 WhatsApp 均查；完整值精确匹配后跳过，不覆盖已有资料 |
| 模糊匹配 | 同邮箱域名、部分号码或多/少国际码不能直接判为同一客户，列待确认 |
| 下拉 | 选择系统实际存在的精确选项，不能只把文字输入搜索框 |
| 保存 | 每条审查字段、保存、核验本次成功提示或新增记录；结果不明先查后重试 |
| 通知 | 不发邮件、WhatsApp 或客户通知，不修改营销订阅状态 |

默认来源为 **Retail站 → Retail站-网站订阅**，跟进状态 **未处理**，行业一级和产品类型 **其他**，负责人 **Kitty**，线索类型 **线索**，重点标记 **否**，行业二级留空。公司名称与 Facebook 主页有真实信息才填。

完整 17 个字段规则见 [字段说明](references/fields.md)。新租户选项不同或指定选项不存在时，记录待确认，不能自动选其他含义的值。

## 结果与断点

完成后报告检查总数、新建数、重复数、失败/待确认数，并列出待确认邮箱、原始号码与原因。部分完成会另报未处理数，不混入成功数。

私有运行目录保留来源快照、查重证据和 `events.jsonl` 保存日志。保存前落盘 `saving` 意图；发生断线、超时或未知结果时保留 `uncertain`，续跑先核对 CRM。按钮变回可点或表单消失不能单独算成功。

本仓库仅包含规则、辅助库和合成测试。**不要提交客户邮箱、号码、聊天、任务断点、浏览器配置、令牌或截图。** `.gitignore` 只是防误提交保护，发布前仍需检查实际文件清单。

## 目录与开发验证

```text
SKILL.md                   Codex 执行入口
agents/openai.yaml         中文技能入口信息
references/fields.md       17 个字段与查重依据
references/workflow.md     连接、组合 API、续跑及 UI 校准
scripts/cdp.mjs            本机 Chrome CDP 直连客户端
scripts/probe.mjs          只读连接探测
scripts/rules.mjs          真实字段与精确查重规则
scripts/ui.mjs             分页、详情、表单及保存辅助库
scripts/journal.mjs        保存前日志与中断恢复
scripts/tests/core.test.mjs 离线行为测试
```

在仓库根目录运行：

```powershell
node --test scripts/tests/core.test.mjs
```

辅助库由 Codex 按当前页面组合调用，默认 `commit: false` 只填表核验；当前用户明确授权录入后才使用 `commit: true`。它不是不经校准、自动适用于所有租户的一键迁移程序。API 示例见 [运行说明](references/workflow.md)。

## 当前验证范围

- 原业务流程在 Windows、Chrome 157、EcomSend `s-table` 页面和询盘云 `xhl-el-*` 表单完成过实际批次。
- 抽取后的代码执行离线测试与当前浏览器只读连接探测；本次制作技能没有额外新建生产测试线索。
- 页面结构、店铺或 CRM 租户改变时先检查标签、对象路由和下拉。测试通过不代表新租户已完成端到端验证。
- 其他电脑需自行安装技能、具备 Node 和网站访问权限；登录同一账号不代表运行记录、浏览器状态或本机断点已同步。
