# 升级执行清单（2026-11-06）

> 这份是"照着做、能打勾"的版本。依据：[任务清单](./TASKS-2026-11-06.md)、[额度方案](./QUOTA-PLAN-2026-11-06.md)、[前后对比](./IMPACT-2026-11-06.md)。
> 排序原则：先止血（正确性 + 护栏）→ 再做上游（源管理）→ 抓取/代理 → EPG → 后台。

## 0. 开工前（0.5 小时）

- [ ] 后台「用量」面板抄基线：KV 写/天、KV 读/天、D1 行写/天、Actions 分钟、KV 存储
- [x] 确认 shell 可用（2026-11-06 已恢复：`node v24.22.0`、`pwsh` 正常，可 typecheck/test/build/push）
- [ ] 确认部署路径：本地无 Cloudflare Token，改完 push `main` → Actions 部署
- [ ] 记住三条红线：**D1 写 90k/天、KV 写 920/天、Actions 1,600 分钟/月**

---

## 1. Batch 0 · 止血与护栏（约 2 人日）

| # | 任务 | 效果 | 额度 |
| --- | --- | --- | --- |
| B0-1 | **分片桶数统一到 8**（`hash.ts` 导出 `BUCKET_COUNT=8`；worker 读 8、runner 写 8、测试断言 8；保留 64 回退） | 详情页/试播真实线路 **约 50% → ~100%** | 0（不重写 16 桶） |
| B0-2 | **连续失败 5 次删源 → 改为 paused**（`db.ts:729-734`） | 源不再凭空消失，可恢复 | D1 写 −1/次 |
| B0-3 | **池快照时间可见**（Pool 页显示 `pool.json` 的 `generatedAt`，按钮明确"重建快照"） | 能判断导出用的是不是新快照 | +1 KV 读/页 |
| B0-4 | **D1 写护栏 + 归因**（≥90k 拒绝 dispatch；每个写路由累计 `meta.rows_written` 到用量面板 TopN） | D1 超限会报错，先止血；顺带查清 89k 是谁写的 | ~0 |
| B0-5 | **Actions 分钟护栏 + 每日 dispatch 上限**（≥1,600 分钟只允许手动；每日 ≤20 次） | 定时探测烧不掉月配额 | 0 |
| B0-6 | **订阅 self-heal 冷却**（同 key 60s 内只写一次；KV 写 >900 时跳过写回） | 防请求触发的 KV 写放大 | KV 写 ↓ |
| B0-7 | **CI/调度省钱**：`ci.yml` 去掉 push 触发（deploy.yml 已跑同样检查）；epg 并入每日发布；发布间隔 6h→12h；探测按"到期线路数"门控 | 省约 600 分钟/月 Actions | Actions ↓ |
| B0-8 | **文档对齐**（`FEATURES.md`/`ARCHITECTURE.md` 里"未做"但已做的项、64 桶改 8 桶） | 下一轮规划不被文档误导 | 0 |
| B0-9 | **补测试**：`sources` / `collect` / `filters` 目前零测试 | 后面改源管理/抓取有回归保护 | 0 |

**Batch 0 验收**：连续两次发布，KV 写 < 60/次、D1 写 < 30k/天；20 个覆盖 `hash%16=0..15` 的频道线路数与 catalog 一致；把 `d1.rowsWritten` 改成 95,000 后点"立即采集"被拒绝且提示明确。

### Batch 0 完成情况（2026-11-06）

| # | 状态 | 实现 / 备注 |
| --- | --- | --- |
| B0-1 | ✅ | `packages/core/src/util/hash.ts` 导出 `BUCKET_COUNT = 8` 并作为默认；`packages/worker/src/lib/catalog.ts` 按 8 → 16 → 64 回退；`packages/runner/src/pipeline/publish.ts` 写 `BUCKET_COUNT`；`build.test.ts` 断言；新增 `packages/core/test/hash.test.ts` |
| B0-2 | ✅ | `packages/worker/src/db.ts` 连续 5 次失败改 `status='paused'`（不删行、不删 stats）；`packages/runner/src/store.ts` 过滤 paused；`routes/sources.ts` 重新启用时清 paused + `consecutive_failures=0`；`Sources.tsx` 显示橙色「已暂停」 |
| B0-3 | ✅ | `GET /api/admin/pool/tree` 返回 `snapshot: { generatedAt, channels }`；`Pool.tsx` 顶部显示快照时间 + 「重建快照」按钮（dispatch `export`） |
| B0-4 | ◐ | 护栏 ✅：`routes/admin.ts` D1 行写 ≥90k 返回 429 `d1_quota`；`lib/tasks.ts` 同条件保持排队。**归因 TopN 未做**（需逐路由统计 `meta.rows_written`，留到用量面板/后续） |
| B0-5 | ✅ | `lib/tasks.ts`：GitHub Actions 本月 ≥1,600 分钟时自动任务保持排队、手动放行；schedule 当日 ≥20 次同样排队 |
| B0-6 | ✅ | `routes/artifacts.ts`：同 key 60s 冷却；usage 显示 KV 写 ≥900 时跳过写回（usage 读取缓存 60s） |
| B0-7 | ◐ | `ci.yml` 已去掉 push 触发（deploy.yml 已跑 typecheck+test+build）。EPG 本就每日 1 次且 `autoPublishAfterProbeEnabled=false`，无重复消耗；「6h→12h」是后台 `autoPublishIntervalHours` 设置项，该功能默认关，未改默认值 |
| B0-8 | ◐ | `docs/ARCHITECTURE.md` 分桶说明已改 8 桶，本清单与 `docs/TASKS-2026-11-06.md` 已同步；`docs/FEATURES.md` 的「未做」条目需逐项核对代码后再改（避免写入未验证结论） |
| B0-9 | ◐ | 新增 `packages/core/test/hash.test.ts`、`packages/runner/test/remote-config.test.ts`；`sources`/`filters` 仍无测试（留 Batch 1） |

**验证**：`npm run typecheck` ✅；`npm test` 99 passed / 22 files ✅。

**部署与线上验收（2026-11-06）**
- push `cf70eef` → `deploy.yml` 成功；首页资产 `index-ZvVO669v.js` → `index-pIAdslPt.js`，`Pool-*.js` 含「重建快照」、`Sources-*.js` 含「已暂停」，确认新前端已上线。
- M1（分片桶）：抽查 40 个 `hash%16≥8` 频道，`/api/public/channels/:id` 的 `lines` 数与 `/api/public/channels` 的 index `lines` 全部一致（mismatch 0）；另抽查 2 个 `hash%16<8` 频道也一致。
- 待复核（需 admin 或下一次定时发布）：连续两次发布 KV 写 <60/次、D1 写 <30k/天；`d1.rowsWritten=95,000` 时「立即采集」返回 429 `d1_quota`；paused 源在后台的显示/恢复；self-heal 60s 冷却。
- 本地 `npm run build` 因 esbuild 临时文件 `Access is denied`（Windows 临时目录权限）失败；CI/Linux 构建部署正常，与本次改动无关。

> 护栏是软护栏：读的是 `state/usage.json` 上一次 usage 上报的数字，最多滞后 6 小时；宁可少跑一轮，也不在超限边缘发任务。

---

## 2. Batch 1 · 源管理（约 13.5 人日，S1、S2、S4–S10 已完成）

| # | 任务 | 效果 | 额度 |
| --- | --- | --- | --- |
| S1 | ✅ **源级请求配置**（`request_headers` JSON：UA/Referer/Cookie/附加头；`fetch_mode`） | 要 Referer 的源能抓了 | 0 |
| S2 ✅ | **备用地址链**（`mirror_urls`，依次尝试，记录用第几个成功） | 主地址挂了不整源失效 | 失败时多 1 次抓取 |
| S3 ✅ | **降级/恢复状态机**（3 次 → degraded，5 次 → paused，半开探测自动恢复；阈值进 settings） | 坏源隔离但不丢，源站恢复后自动复活 | 半开并入现有 fetch 运行 |
| S4 ✅ | **解析诊断留档**（`parse_report` 存 D1 列：detectedKind/entries/groups/warnings/bytes；条数突变 >30% 标黄） | 能回答"这源这次解析出了什么" | D1 每源 1 次 UPDATE，无新增行 |
| S5 ✅ | **源健康面板 2.0**（最近错误+归类、连续失败、贡献频道数/导出线路数、"需处理"排序、7 天 sparkline） | 排障从 5–8 步变 1 屏 | 0 |
| S6 ✅ | **批量操作与源标签**（多选启停/改优先级/加标签/删除；标签筛选） | 维护 20 个源不用逐个点 | D1 每次批量 N 次 UPDATE |
| S7 | ✅ **新源导入与单次复测**（首次可用标记；新线路失败一次进待复测、复测失败即终态；好线路直接入池） | 新源坏线路最多探测两次，之后不再占批次 | Actions ↓ |
| S8 | ✅ **已淘汰终态与生命周期**（终态不再探测；保留 30 天、不设上限；清理写墓碑；按线路/按源手动复活；每月抽检） | 淘汰线路不消耗额度，重抓不回池 | Actions ↓ |
| S9 | ✅ **定时重抓与线路对比**（多时段 + 单源 12/24/72 小时；新增进待测、淘汰跳过、消失标已下架） | 源更新自动生效，对比报表可查 | 无 |
| S10 | ✅ **空闲跳过**（待测/待复测为 0 时跳过分批探测；源都未到期时跳过抓取） | 空队列日不再产生固定开销 | Actions ↓ |
| S0 ✅ | **适配器契约（收尾项，不急）**（`core/src/source/adapter.ts`：id/detect/parse/validate 注册表，包住现有 4 种格式） | 以后加"站点 JSON API"型源只加一个文件 | 0 |

**验收**：造一个 404 源跑 5 轮 → paused 且可恢复；配置 Referer 的源抓取成功；源详情能看到最近两次解析差异；新源 5 条坏线路两轮内全部终态、第三轮不再探测；连续 3 轮无 rejected 批次。

---

## 3. Batch 2 · 抓取与代理（约 8 人日，F1/F4/F5/F3/F6/F2 已完成 2026-11-06）

| # | 任务 | 效果 | 额度 |
| --- | --- | --- | --- |
| F0 | ✅ **统一 fetch 层**（`core/src/source/fetch.ts`，替换 worker/runner 两套实现） | 改一处不再漏另一处 | 0 |
| F1 | **错误归类 + 选择性重试**（只重试超时/429/5xx；4xx 不重试；`last_error_kind`） | 少做无用功，日志可归因 | Actions ↓ |
| F4 | **编码健壮性**（GBK/BIG5/BOM 解码；坏行容忍） | 乱码源能导入 | 0 |
| F5 | **每源抓取参数**（超时/并发/间隔，默认沿用全局） | 慢源不拖整轮 | Actions ↓ |
| F3 | **抓取侧代拉 + 官方源保底**（`fetch_mode=worker`；`official` 线路不判死、导出置顶） | CCTV 官方线路能进导出（现在 0 条） | +1 KV 写/源/轮 |
| F6 | **中继热路径**（单份紧凑 `state/line-index.json` + 缓存 60s；旧 `/relay` 收敛；补 Cookie/Origin） | 中继不再每分片解析 20MB `probe.json`（现在必超 10ms CPU） | +1 KV 写/发布 |
| F2 | **订阅级代理三模式**（direct / playlist / full；默认 direct；full 需显式开启 + 每 token 配额） | 被网络拦截的用户能选代理 | 全代理吃请求，默认关 |

**验收**：三种模式导出的 M3U 分别 0 / 仅清单 / 全部中继地址；禁用订阅后中继立即 401；单分片请求不再解析全量 probe.json。

---

## 4. Batch 3 · EPG ✅（已完成，2026-11-06）

| # | 任务 | 效果 | 额度 |
| --- | --- | --- | --- |
| E2 | **覆盖率口径修正**（校验 `guide.generatedAt`，过期返回 stale，不再假 100%） | 覆盖率可信 | 0 |
| E1 | **未映射清单 + 反向绑定**（`state/epg-unmatched.json`；EPG 名→选频道绑定；`x-` 噪声频道不再进 D1/可清理） | 覆盖率能真正提升，噪声频道下降 | +1 KV 写/发布 |
| E4 | **EPG 源优先级与健康**（源排序/权重；`state/epg-sources.json`；取消"全删再灌"） | 多源冲突可控 | +1 KV 写/发布 |
| E3 | **官方节目表回退**（`tv.cctv.com` 补 CCTV 系，只补缺口频道，限 50 个） | XMLTV 全挂时 CCTV 仍有节目 | Actions +1–3 分钟/天 |
| E5 | **订阅 EPG 瘦身**（按频道集哈希去重复用；desc 截断；超大回退共享 epg.xml） | 20 个订阅产物体积降 30–50% | KV 写 ↓ |

---

## 5. Batch 4 · 管理后台（A1–A6 已完成）

| # | 任务 | 效果 | 额度 |
| --- | --- | --- | --- |
| A1 | **运营事件页**（`/admin/events`：报障状态流转+转探测；审计分页/筛选/详情） | 报障与"谁改了什么"有闭环 | 0 |
| A2 | **失败原因聚合与趋势**（`/insights/failures` TopN + 按源/阶段；7 天折线，手写 SVG） | 一眼看出最近坏在哪 | D1 读，需加索引 |
| A3 | **频道编排工作台**（拖拽排序 + 批量启停/改名；`sort` 真正进发布顺序） | M3U 顺序可控 | D1 +≤512/次拖拽 |
| A4 | **规则命中预览**（runner 侧命令，Worker 不跑） | 规则保存前知道命中多少 | 1 次按需 Actions |
| A5 | **反馈进信誉分**（近 30 天有效报障折算小权重） | 差源自动降权 | D1 +20/轮 |
| A6 | **（可选）设备令牌**（`subscription_tokens`，last_seen 每小时最多写 1 次） | 多设备可分别封禁 | D1 需节流 |

> 2026-11-06 状态：A1–A6 已上线。A4 实际实现为 Worker 侧「仅名称级」预览（≤100 条、不读 catalog、不进热路径），未走 Actions；A3 的 `sort` 已通过 `listChannels` 进入 runner 发布顺序。A6 增加 `subscription_tokens`（迁移 0024）与设备级启停，`last_seen` 每设备每小时最多 1 次写。

---

## 5.5 Batch 2.5 · 平台源（已确认：央视频 + 咪咕，约 6.5–8.5 人日）

> 详见 [PLATFORM-SOURCES-2026-11-06.md](PLATFORM-SOURCES-2026-11-06.md)。建立在 F6 + F2（playlist 模式）之后；
> 顺序 P-1 → P-2 → P-3 → P-4；P-3 复用 P-1 框架，P-4 收尾。2026-11-06 用户确认两者一起做。
> 2026-11-06 晚：用户决定**暂时跳过**（无外部解析器时原生实现 JCE 风险过高），P-1–P-4 均未做。

- [ ] **P-1 央视频适配器**（JCE 时移 + bkliveinfo 备用；63 路；`/platform/ysp/<ch>.m3u8`；Cache 6–10s；分片直连央视 CDN）— 2.5 人日
- [ ] **P-2 平台线路接入线路池**（稳定 key + `official` 标记 + 导出置顶 + 不判死）— 0.5 人日
- [ ] **P-3 咪咕适配器（实验性）**（现签凭证、默认关闭、单订阅开启、不进公共订阅）— 3–5 人日
- [ ] **P-4 平台源健康面板**（每适配器最近成功/失败原因）— 0.5 人日

额度提示：每观众每 6–10 秒 1 次清单请求（≈360–600 次/小时），Cache 后多观众共享；**不要公开推广**。

## 6. 总验收（全部完成后）

| 指标 | 目标 |
| --- | --- |
| M1 详情页能读到真实线路的频道占比 | ~100% |
| M2 失败源保留/可恢复率 | 100% |
| M3 抓取失败可归因率 | 100% |
| M4 EPG 覆盖率可信度 | 真实值 + stale 标记 |
| M5 订阅可选代理模式 | 3 |
| M6 定位一个坏源的步骤 | 1–2 步 |
| 额度 | D1 写 < 90k/天、KV 写 < 900/天、Actions < 1,600 分钟/月 |

## 7. 明确不做

1. Node.js + Docker 常驻服务（与 Cloudflare-only 冲突）
2. B站/抖音/虎牙/斗鱼的直播逆向（不是线性电视、DRM/反爬重、价值低）
3. 账号型私有接口的大规模使用（登录态/设备注册签名/4K HEVC 平台流）
4. 把平台源放进公开频道列表或公开订阅（版权与额度双重风险）
5. 复制 GPLv3 代码（akiralereal 只借设计）
6. 自建 Android 播放器（另有方向，另议）

## 8. 可选/兜底（不在人日估算内）

- [ ] Workers 付费 $5/月（一次性解除额度焦虑，最便宜）
- [ ] KV 分片/冷存（2–3 人日，线路池接近 25MB 时的扩展路径；不引入 R2/S3）
- [ ] 多地区探测（self-hosted runner 矩阵，独立议题）
