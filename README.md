# 跨城剧场同步演播

服务面向剧场跨城同步演播的无障碍协同：以源演出的台本与场次时间线为基准，协调各城市剧场获得与当晚舞台一致的辅助内容（字幕、口述影像、手语、接收设备等）。

运行 `npm run check` 可核对配置，执行 `npm test` 可验证接口契约；使用 `node service.js` 启动服务后访问 `/health`。

## 能力概览

- **台本基准与选择性召回**：登记台本版本（`POST /productions/:id/script-versions`），台词、走位或时长变化时，按内容敏感度只召回受影响的辅助内容——台词改动波及字幕与口述，走位改动波及口述，时长改动波及计时内容与排班；设备与席位登记不受影响。
- **按职责确认发布**：字幕语种、口述稿、手语译员、接收设备、席位需求、彩排核验统一登记为辅助内容（`POST /assets`），经提交后由翻译、导演、当地负责人按职责确认（`POST /assets/:id/approvals`），确认齐全方可发布（`POST /assets/:id/publish`）；被召回内容需修订（`POST /assets/:id/revise`）生成新版本并重新确认。
- **临场对齐与提示去重**：场次排定（`POST /performances`）时快照当晚采用的台本版本与辅助内容；暂停、跳段、返场（`POST /performances/:id/events`）后字幕与口述提示自动重新对齐（`GET /performances/:id/cues`）；网络恢复后迟到的同步批次按提示编号去重，已播提示不重复播出（`POST /performances/:id/dispatches`）。
- **人工跟随留痕**：自动同步失效可切换人工跟随（`POST /performances/:id/manual-overrides`），切换原因、起止位置、操作人与观众告知方式必须记录；切换期间自动播出暂停，恢复后留有完整审计（`GET /audit`）。
- **隐私与同意**：剧场资料包（`GET /performances/:id/venue-pack?venueId=`）只含本场所需辅助资料与匿名需求数量；观众障碍信息与联系方式按同意范围分级开放（`GET /needs/:id/pii`），每次访问留痕。
- **追溯与缺口分析**：从一条投诉还原当晚台本版本、辅助内容快照、人员排班、设备与彩排检查、临场事件、人工切换与补救结果（`GET /complaints/:id/trace`）；按城市汇总供给缺口，同一缺口出现在两个及以上场次即标记为反复出现（`GET /cities/:id/gaps`）。

## 模块结构

- `src/store.js` — 内存数据存储与审计日志
- `src/scripting.js` — 台本版本登记与选择性召回
- `src/assets.js` — 辅助内容登记、分职责确认与发布
- `src/live.js` — 场次排定、临场事件对齐、提示播出与人工跟随
- `src/privacy.js` — 剧场资料包与同意范围控制
- `src/trace.js` — 投诉追溯与城市缺口分析
- `src/api.js` — HTTP 路由
