# 跨城剧场同步演播 · 无障碍统筹协同后端

服务面向跨城同步演出的无障碍专场：以源演出的**台本版本**与**场次时间线**为基准，统筹各城市剧场的字幕、口述影像、手语译员、接收设备与席位需求，保证不同城市拿到的辅助内容与当晚舞台一致。

## 核心能力

- **台本基准与定向召回**：台本按版本登记，逐片段对比台词、走位、时长。变更时只召回引用了受影响片段的提示，并按变化类型重置对应职责的确认（台词→翻译/导演，走位→导演，时长→导演/当地负责人），其余内容与确认保持不变。
- **按职责确认后发布**：字幕需翻译与导演确认，口述稿需导演确认，手语排班需当地负责人确认；确认不齐或仍有召回内容待修订时不得发布。
- **演出中实时对齐**：暂停/恢复将后续未播提示整体平移，跳段作废被跳过的提示，返场留下重对齐记录；提示播出按会话幂等，网络恢复后迟到的重放不会重复播出。
- **人工跟随留痕**：自动同步失效可切换人工跟随，切换原因、起止位置、是否告知观众强制记录，并写入审计日志。
- **数据最小化**：剧场简报只含本场所的已发布资料与匿名需求数量；个别观众的障碍信息与联系方式按同意范围（统筹/场所/联系方式）分别开放。
- **投诉追溯与缺口分析**：从一条投诉可还原当晚的台本版本、辅助内容、人员排班、设备检查、临场切换与补救结果；按城市聚合供给缺口，两个及以上场次出现缺口的城市标记为反复缺口。

## 结构

- `src/store.js` — 内存集合与追加式审计日志（追溯的事实来源）
- `src/coordinator.js` — 领域核心：台本/召回/确认/直播对齐/隐私/追溯/缺口
- `service.js` — HTTP 层：路由、角色头解析、统一错误格式
- `coordinator.test.js` / `service.test.js` — 领域流程与接口契约测试

## 接口概览

调用者身份通过请求头传递：`x-actor-id`、`x-actor-role`（coordinator / translator / director / local-lead / venue-staff）、`x-venue-id`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| POST | `/productions` | 创建制作 |
| POST | `/productions/:id/script-versions` | 登记台本版本（自动定向召回） |
| POST | `/shows` · GET `/shows/:id` | 排期 / 场次视图 |
| POST | `/shows/:id/assets` | 登记字幕轨 / 口述稿 / 手语排班 |
| POST | `/assets/:id/confirm` · `/revise` · `/publish` | 职责确认 / 修订召回内容 / 发布 |
| POST | `/shows/:id/devices` · `/devices/:id/checks` | 接收设备登记与检查 |
| POST | `/shows/:id/demand` | 匿名席位需求数量 |
| POST | `/shows/:id/rehearsal-verifications` | 彩排核验 |
| POST | `/shows/:id/audience` · GET 同路径 | 观众登记 / 按同意范围查询 |
| GET | `/venues/:venueId/shows/:showId/brief` | 场所简报（数据最小化） |
| POST | `/shows/:id/live/start` · `/live/events` · `/live/dispatches` · `/live/manual-switches` | 开演 / 暂停跳段返场 / 提示播出（幂等）/ 人工跟随 |
| POST | `/shows/:id/complaints` · `/complaints/:id/remediation` | 投诉登记与补救 |
| GET | `/complaints/:id/trace` | 投诉追溯（还原当晚事实） |
| GET | `/analytics/supply-gaps` · `/audit?showId=` | 供给缺口分析 / 审计日志 |

错误统一为 `{ "error": { "code", "message" } }`，状态码遵循 400 / 403 / 404 / 409。

## 运行

```sh
npm run check   # 核对服务身份与配置
npm test        # 运行全部测试
node service.js # 启动服务，默认 127.0.0.1:8000
```
