# 来源与消费契约

## 来源

入口 `/partners/{partner}/roster`，HTML 内的 source-record JSON 节点保留了门户输出字段；rel=next 链接表示下一页。`fixtures/source.json` 的 opening 与 updated 是两个可切换的来源观察；`fixtures/source-lifecycle.json` 额外提供 renamed/missing/withdrawn/backfilled 四个观察，用于验证改名、页面缺席、显式撤回与事后补录。可继续添加新的来源观察验证行为。

registrationId 属于 partner，personRef 是明确提供的参会人关联号；改名不会产生新人。合作方页面缺席不证明撤销，status=cancelled 才是撤回证据。空页面是合法观察，采集端记录批次缺席但不改动任何报名状态。fixtures/attendance.json 是独立的现场签到事件，fixtures/settlements.json 是已确认结算依据；名单和签到不能相互覆盖，结算确认一经登记不可重写。

## 业务消费

`readOperations(repository)` 保持原有签名，返回 product 和 rows，每行带 sourceId/source/observedAt/attributes。新增 `readLedger(stores, { asOf, session })` 在同一业务读取入口暴露三类留痕的一致时点视图：日报（有效报名、撤回、实际到场、计费身份）与结算确认清单。

对账解释规则由实现保证：

- 报名身份为 `partner:registrationId`，跨来源归并只认 personRef；同场次同一 personRef 的多条有效报名合并为一个计费身份并标记 `duplicate-billing-identity`。
- 日报与对账都按显式 asOf 时点求值；observedAt 晚于时点的观察不参与当时结论。
- 已确认结算依据是不可变快照；后到更正只能产生差异代码（确认后改名/撤回/补录/签到、确认对象当前缺席等），不能回写确认。
- 原始来源身份与 observedAt 不是通用的业务版本、完整性或成功证明。来源接口契约是兼容边界，采集、状态管理和新业务表达由实现决定。
