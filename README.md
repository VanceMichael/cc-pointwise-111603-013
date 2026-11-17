# 展会报名同步台

Node.js 本地数据接入项目。来源服务与业务存储独立，来源变化不会自动刷新本地集合。系统在首批结构化导入之外，新增了**可追溯的结算对账生命周期**：合作方名单采集只追加留痕、现场签到独立留存、结算确认不可变，所有跨来源关联都通过明确身份完成。

## 运行

需要 Node.js 22，无第三方包、远程服务或账户凭据。

- `npm test` 运行全部行为与本地接口测试（27 项）。
- `npm run demo` 保留原有首批导入演示；`npm run demo:reconciliation` 演示完整对账生命周期（采集 → 确认 → 改名/缺席/撤回/补录 → 差异解释），结束自动清理临时数据。
- `npm run acceptance` 在临时目录中验证来源读取、首批导入、重启回读、重放、业务查询以及完整对账工作流。
- `npm start -- --help` 查看全部命令。

## 数据模型与留痕原则

状态目录默认是 `var/`，可用环境变量 `COLLECT_STATE_DIR` 重定向（测试与临时运行互不干扰）。三类事实分文件留存，任何一类都不会覆盖另一类：

| 文件 | 内容 | 语义 |
| --- | --- | --- |
| `roster.json` | 名单 `observations`（只追加）与采集 `batches` | 补录、改名、撤回都成为新观察；批次记录 `seenKeys`/`missingKeys` |
| `attendance.json` | 现场签到事件 | 按 `eventId` 幂等合并，名单修订不改写签到 |
| `settlements.json` | 已确认结算依据 | 同一 `(场次, 确认时点)` 不可变，冲突重提直接报错 |
| `records.json` | 原有首批导入集合 | 保持既有 CLI 与查询能力不变 |

### 身份与防重复计费

- 报名身份是合作方命名空间键 `partner:registrationId`（不同合作方的相同 registrationId 不是同一报名）。
- `personRef` 是明确提供的参会人关联号：**改名不产生新人**，跨合作方、跨修订的记录通过它归并。
- 计费去重单位是 `personRef@session`。同一人在同一场次存在多条有效报名（哪怕换了名字或来自不同合作方）时，日报输出 `duplicate-billing-identity` 差异，只能按一个身份结算一次。

### 有效报名状态

- 页面暂时查不到报名**不等于取消**：缺席只体现在采集批次的 `missingKeys` 中，历史观察继续有效。
- 只有来源明确给出 `status=cancelled` 才是撤回证据，撤回观察同样按时间留痕。
- 时点视图（`effectiveAt` / 日报）取 `observedAt <= asOf` 内每个报名的最新观察，可复现任一时点的有效报名、取消与实际到场。

### 结算确认与后到更正

结算确认是不可变快照。确认之后到达的改名、撤回、补录、签到不会改写确认依据，而是在对账结果中以差异代码单独解释：

- `renamed-after-confirmation` / `revised-after-confirmation`：确认后改名或修订，身份关联不变；
- `cancelled-after-confirmation`：确认后撤回，依据不变、差异单列；
- `registered-after-confirmation` / `attendance-after-confirmation`：确认后补录或后到签到，进入下一周期；
- `confirmed-registration-missing` / `confirmed-attendance-missing`：确认依据在当前观察中缺席，以确认依据为准；
- `valid-registration-not-in-confirmation` / `attendance-not-in-confirmation`：确认时点已存在但未入账，需要人工解释；
- `duplicate-billing-identity`：同一身份同场次多条有效报名；
- `attendance-without-valid-registration`：签到找不到同时点有效报名，事实保留但不据此补计费用。

## 命令

| 命令 | 作用 |
| --- | --- |
| `ingest [文件]` / `query [来源]` | 原有首批导入与集合查询，行为不变 |
| `roster [文件] [observedAt]` | 导入名单观察（数组或 `{records: [...]}`），追加留痕并记录批次 |
| `attendance [文件]` | 幂等合并现场签到事件，独立留存 |
| `settlement [文件]` | 登记不可变结算确认，重复且一致为幂等，冲突重提报错 |
| `report [场次] [时点]` | 按场次与时点输出有效报名、撤回、到场与差异；省略场次则汇总全部场次 |
| `reconcile [场次或文件] [时点]` | 对照已确认依据输出对账解释；不给场次取最近一次确认 |
| `collect 来源URL [合作方..]` | 实时遍历合作方名单（含 rel=next 分页、ETag/304），追加到名单留痕 |

## 组件

`source/server.js` 提供可切换观察版本的回环来源（支持 ETag/304、故障注入）；`src/source-client.js` 只接受同一回环来源并把 304 表达为 `notModified`；`src/adapter.js` 解析名单页面，空页合法（缺席不是撤回）；`src/collector.js` 负责多合作方采集与 ETag 记忆；`src/roster-store.js`、`src/attendance-store.js`、`src/settlement-store.js` 是三类独立留痕；`src/reconciliation.js` 提供时点日报与对账解释；`src/operations.js` 同时保留原 `readOperations` 与新台账入口 `readLedger`。来源协议见 [CONTRACT.md](CONTRACT.md)。
