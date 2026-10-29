# 交接记录 · 2026-10-27

> 明天继续时先读这一页，再按「明日待办」顺序推进。

## 一、今日完成

### 部署

- Worker：`https://iptv.xu05236.dpdns.org`（自定义域名，workers.dev 在国内被 TLS 阻断）
- 当前 Worker 版本：`aa523a13-3bba-41a5-9e05-fed4d151cf2b`
- D1：`iptv-studio` / `da4e65ee-de99-455e-88ed-eb06d10cd139`
- KV：`iptv-studio-kv` / `d4fc0301922746df8af08e288172c1c4`
- 仓库：`github.com/xu05236/iptv-studio`（Private，SSH 推送）
- 凭据：`packages/worker/.deploy-secrets.txt`（已 gitignore，**不要提交**）

### 功能

- 首个 Actions 采集 + 测速 + 发布成功（1200 条预算、216 条可用）
- 订阅自动渲染与预渲染、ETag/304、KV 自缓存
- 默认 EPG 源（fanmingming + epg.pw）+ CNTV 央视增强源
  - 央视 18 频道 / 787 条节目
  - EPG 产物约 6.1MB，516 个频道条目
- 浏览器试播修复：
  - 公开 API 不再返回真实 `url` / 请求头
  - 新增线路级中继 `/relay/line/<key>`，HLS 分片 HMAC 签名，15s 上游超时
  - 播放器区分 HTTP 混合内容、RTSP/RTMP、HLS 跨域
- 后台「采集站」：显示站点域名、完整地址、条目/可用、信誉、启停/检查/抽样/删除
- 检测中心：统计卡 + 分辨率分布 + 搜索/状态筛选 + 明细表（分辨率/速率/首字节/检测时间/来源站点）
- 分辨率：URL/名称推断 + ffprobe 实测补全（仅 alive 且缺分辨率的线路，`FFPROBE_LIMIT` 默认 150）
- 订阅：新增「指定频道」多选，支持分组 + 频道组合
- 频道分类修复：
  - 同步时「其他」只能升级为有效分组
  - 后台「频道」新增「修复分类」按钮
  - 重建索引后央视分组 19 个频道，`CCTV-12` 已归入央视

### 线上数据快照

- 频道：855；线路：2020；可用：25（最近一次导出）
- 分辨率：1080p 193、720p 130、480p 19、2160p 8、1440p 1，其余为实测/未知
- 未知分辨率 1646：名称/URL 无清晰度标记且线路未测通

## 二、明日待办（P0）

1. **补 Hunan TV 别名**
   - `Hunan TV (2160p)` 目前被归到「地方」，应映射到 `hunan-weishi`
   - 位置：后台频道 → 别名，或 `packages/core/src/normalize/channels.ts` 种子
2. **全量测速 / 提高可用数**
   - 当前只有 25 条 alive，大量线路未测或失效
   - 现有 `planProbes` 只测「到期」线路，无法强制全量
   - 建议：增加 `PROBE_FORCE=1`（忽略 TTL，按预算全测），或临时把 tier TTL 调小
3. **订阅名称**
   - 创建时被 PowerShell 编码成 `????`，后台手动改名即可；若仍是乱码，检查 API 写入编码
4. **轮换 ADMIN_TOKEN**
   - 令牌曾出现在聊天记录，建议 `wrangler secret put ADMIN_TOKEN` 后重新登录
5. **确认 CI**
   - `ci.yml` 在 push 时运行；本地网络看不到 Actions 状态，明天在 GitHub 页面确认是否绿

## 三、下周可做（P2，已记录）

- **EPG 卫视/地方台官方源适配器**（原计划等紧急修改后提醒）
  - 候选：湖南/浙江/江苏/东方/北京
  - 复用 `core/src/epg/cctv.ts` 模式
  - 详见 `docs/ROADMAP.md` P2-1
- 反馈数据折算进源信誉分
- 规则可视化编辑器
- 快照一键回滚
- 多地区探测（self-hosted runner）
- 非 HLS 分辨率（TS PMT/SPS 解析）
- 截图 AI 视觉校验

## 四、运行手册

```bash
# 本地类型检查 / 测试
npm run typecheck
npm test

# 改代码后部署（本机 wrangler 已登录）
npm run deploy

# 仅部署 Worker（前端已构建）
cd packages/worker && npx wrangler deploy

# 数据库迁移
npm run db:migrate

# 推送代码（SSH key 在 .tools/ssh，需 GIT_SSH_COMMAND）
$key=(Resolve-Path .tools\ssh\id_ed25519).Path
$env:GIT_SSH_COMMAND="ssh -i `"$key`" -o IdentitiesOnly=yes"
git push
```

Actions 手动入口：

- 采集 + 测速：`command=collect`，`budget=300/1200/6000`
- 仅重建导出（含 ffprobe）：`command=export`
- 仅更新 EPG：`command=epg`

## 五、关键文件

| 文件 | 作用 |
| --- | --- |
| `packages/core/src/epg/cctv.ts` | 央视 EPG 解析 |
| `packages/core/src/util/text.ts` | `inferResolution` / 频道归一化 |
| `packages/runner/src/pipeline/ffprobe.ts` | 分辨率实测补全 |
| `packages/runner/src/pipeline/publish.ts` | 目录/分桶/`probe.json` 发布 |
| `packages/worker/src/routes/relay.ts` | 线路级中继 |
| `packages/worker/src/routes/admin.ts` | 检测数据接口 |
| `packages/worker/src/routes/channels.ts` | 频道 CRUD / 修复分类 |
| `apps/web/src/pages/admin/Probe.tsx` | 检测中心 |
| `apps/web/src/pages/ChannelDetail.tsx` | 前台频道详情/试播 |

## 六、已知限制（避免明天重复踩）

- 本机到自定义域名的 HTTPS 抖动严重（30–90s 超时），验证尽量用 `curl -m 90` 或 GitHub Actions
- 本地 `wrangler d1 ... --local` 会因 Windows 权限起不来，远程命令正常
- Workers 免费版 CPU 10ms，订阅必须走预渲染/R2→KV 静态对象
- KV 单值 25MB，EPG/线路状态有 24MB 保护
- RTSP/RTMP 浏览器无法播放，只能 VLC/盒子
- 中继已开启，会消耗 Worker 流量；如遇限速可在「设置 → 高级」关闭

---

# 2026-10-28 上午续记

## 已完成

- `Hunan TV` 等英文名加入湖南卫视别名（`Hunan TV / Hunan Satellite TV / HunanTV`）
- 新增 `PROBE_FORCE`：
  - Actions 输入 `force=true`
  - 后台「检测中心 → 强制全量」
  - 临时分支 `run-collect` 推送即触发（`collect-force.yml`）
- 频道名清理：重命名 220 个，去掉 `(1080p)`、`[Geo-blocked]`、`[Not 24/7]`，繁转简
- 后台「频道」新增「清理名称」按钮
- 配置 `GITHUB_REPO` / `GITHUB_WORKFLOW` / `GITHUB_REF`，写入 `GITHUB_TOKEN` Secret，修复后台触发 400（网络原因尚未完成最终点击验证）

## 事故与修复：强制全量把可用数打崩

- 第一次强制全量：并发 48，2043 条全测，alive 从 235 掉到 39
- 原因：高并发下大量原本可用的线路瞬时超时，被状态机一次判死
- 修复：
  1. 之前 alive 的线路探测失败自动重试一次
  2. 强制全量并发降到 16
  3. 可用数腰斩保护：`aliveAfter < aliveBefore * 0.5` 时放弃发布
- 恢复运行：2043 条，**alive 恢复到 339**，比事故前更高
- 分辨率同步改善：1080p 168、720p 119、1080 实测 155、720 实测 40，未知 1474

## 当前线上

- 855 频道 / 2020 线路 / 339 可用
- Worker 版本：`cce29bd3-7607-47e0-a05f-abfcfa4b666a`（之后只改了 runner）
- 最新运行：`run-mvrfyuj5-aeny`（09:34 UTC，forced，success）

## 待办

- [ ] 验证后台「全量检测 / 重建导出」按钮（Token 已配，网络抖时多试一次）
- [ ] 轮换 `ADMIN_TOKEN`：当前 PAT 没有 Secrets 写权限，需要在 GitHub UI 改 `ADMIN_TOKEN`，或新建带 Secrets 权限的 PAT
- [ ] 删除/保留 `run-collect` 分支的取舍（保留=可推送触发，删除=只能 Actions 手动）
- [ ] EPG 卫视/地方台官方源适配器（下一步主线）
- [ ] CI 已连续 success，可放心继续
## 2026-10-28 中午补充

- 修复后台触发 422：GitHub workflow_dispatch 只接受 `command/budget/force`，已移除多余输入
- 后台「全量检测 / 强制全量 / 重建导出」按钮恢复可用
- 新增每订阅 EPG：`out/epg-<subId>.xml`，`/epg/<token>.xml` 优先返回该文件（下一次 collect 生成）
- 当前数据：855 频道 / 2020 线路 / 339 可用（02:25 UTC 发布）
- 卫视官方 EPG 接口调研：芒果 TV 仅暴露 `api.mgtv.com`，实际调用需签名参数，暂不硬接
## 2026-10-28 下午：源过滤与去重

- 新增源级过滤（采集站卡片「过滤」）：
  - 只保留分组 / 排除分组
  - 频道名包含 / 排除关键词
  - 最多保留条数
- 过滤在 runner 解析后、归一化前执行；不删除已入库频道
- 去重改为记录 `sourceIds`：同一 URL 被多个源提供时只保留一条线路，但「N 个源」按所有来源统计
- 重复源拦截：
  - 相同规范化 URL → 409
  - 相同内容 SHA-256 → 409
- 修复 runner 304：源返回 304 时没有本地正文，改为无条件重取，避免过滤/解析被跳过
- 实测 `all-7990`：7946 条 → 过滤后 1202 条，频道 7596 → 1203，线路 2926，可用 341
## 2026-10-28 晚：主域名切换三网优选 CNAME

- `iptv.xu05236.dpdns.org` 不再使用 Worker 自定义域名（Cloudflare 代理）
- 改为 DNS-only CNAME：`iptv.xu05236.dpdns.org` → `youxuan.cf.090227.xyz`
- 通过 Worker Route 提供服务：`iptv.xu05236.dpdns.org/*`（`wrangler.jsonc` 已改为 route 配置）
- 实测：首页 200、健康接口连续 6 次 200、后台频道树 200；延迟约 0.6–6 秒
- 临时测试域名 `pref-test` / `iptv2` 已删除
- 回滚：恢复 `custom_domain` 配置并 deploy，删除 CNAME 与 route，重新创建自定义域名
- 注意：CNAME 目标可用性依赖 `youxuan.cf.090227.xyz`；若该域名失效，主站会不可用
## 2026-10-28 收尾

- 清理空频道：删除 4325 个（保留 1125 个当前发布频道）
- D1 `sync/channels`：改为只更新有变化的行；绑定参数批次降到 80，修复 500
- 用量面板：GitHub Actions / KV / D1 已接入，另加近 7 天趋势
- `usage` workflow：每 6 小时更新，权限 `actions: read`
- KV 写入优化：相同内容不重复写；订阅文件头移除每次变化的时间戳
- 源更新间隔：默认 24h，未到期复用线路
- 精品线路：每频道前 6 条 72h 内不重复测；导出淘汰明显低分辨率/低速线路
- 主域名：DNS-only CNAME `iptv` → `youxuan.cf.090227.xyz` + Worker Route
- 临时 `run-collect` 分支已删除；`admin.ts` 重复 usage 路由已清理
- 今日用量：KV 写 882/1000、D1 写 89015/100000、Actions 132/2000 分钟（含清理尖峰）
---

# 2026-10-28 傍晚 · 当前基线

## 线上数据

- 频道 1125 / 线路 2821 / 可用 341
- D1 写 89,015 / 100,000（今日，含清理尖峰）
- KV 写 882 / 1,000（今日）
- GitHub Actions 132 / 2000 分钟（本月）
- 主域名：`iptv.xu05236.dpdns.org` → DNS-only CNAME `youxuan.cf.090227.xyz` → Worker Route
- 自动部署：push 到 main 的 worker/core/web 改动自动 Deploy

## 本轮已完成

- 空频道清理：删除 4325，保留 1125
- D1 `sync/channels` 只更新变化行；绑定批次 80，修复 500
- 用量面板 + 近 7 天趋势 + 全局红色/橙色告警
- 用量快照 workflow 每 6 小时，GitHub Actions 分钟数可读
- KV 相同内容不重复写；订阅文件头去掉生成时间
- Worker cron 改为每 6 小时，并跳过已 degraded 的源
- 前端请求超时改为 15 秒 / 2 次重试（6 秒会把 9–10 秒的 TLS 握手直接掐断）
- 源更新间隔（默认 24h）、精品线路 72h 不重复测、导出质量底线
- 批量移动分组、国家/分组树、50 条/页分页

## 明天优先做

1. **别名库扩充**（最高优先，不耗采集额度）
   - 从 iptv-org / EPG / 现有源提取同频道不同写法
   - 候选聚类 + 人工确认
   - 别名冲突检测、批量导入
   - 注意 Guovin/iptv-api 是 AGPL-3.0，不能直接复制其数据/代码
2. **源内容缓存**：304 时读缓存，真正做到零下载
3. **自适应测速预算**：按到期线路数、近 7 天存活率、剩余额度动态给预算
4. **前台线路折叠**：默认只显示前 6–8 条优质/可用线路，其余展开

## 风险 / 注意

- D1 和 KV 今天都接近免费上限，明天先看 10-29 趋势是否回落
- 优选 CNAME 依赖 `youxuan.cf.090227.xyz`，失效时按 HANDOFF 回滚
- TLS 仍可能 9–10 秒；15 秒是兜底，不是加速
- Cloudflare Token 在聊天中出现过，按你的决定暂不轮换
- 前端请求失败会显示「重新加载」，不再无限转圈
## 别名库后续候选（暂缓，等新需求排期）

- **方案 A：扩充新频道种子**
  - 把 iptv-org/database 里约 970 个未匹配的中文频道加入内置频道库
  - 优点：覆盖地方台/港澳台更多频道
  - 风险：频道表变大，需观察归一化和探测影响
- **方案 B：现有 x- 频道与内置频道模糊匹配**
  - 对现有 D1 里的 x- 频道做相似度匹配，生成合并/别名候选
  - 优点：直接减少重复频道，风险更低
  - 建议顺序：先 B 后 A

> 用户提出新想法，以上两项暂不执行，等新需求明确后再排期。
## 2026-10-29 · CCTV 官方保底与频道排序

- 前台频道新增排序：`可用优先`（默认，0 可用排最后）和 `名称排序`（CCTV1/CCTV2/CCTV10 自然顺序）
- CCTV 官方 CDN 验证：本机带 Referer 可播，但 GitHub Actions 出口超时；官方流还带请求方 IP/hash，不能做静态源
- `official-cctv` 源默认禁用，避免产生 suspect 噪声
- CCTV 频道详情新增「官方直播」按钮，跳转 `tv.cctv.com` 对应频道页，作为稳定保底入口
- 若要变成 IPTV 线路，需要单独的 Cloudflare Worker 中继/代理，后续再做
## 2026-10-29 EPG 体积优化

- 合并窗口：7 天 + 12h → **2 天 + 12h 回看**
- 每频道节目上限：500 → 180 条
- 每订阅 EPG 预压缩为 gzip：raw 2.56MB → **约 345KB**
- Worker 仅在客户端 `Accept-Encoding: gzip` 时返回压缩文件，其他客户端回退原始 XML
- 注意：`export` 不会重新抓 EPG；EPG 变更需要跑一次 `collect`
## 2026-10-29 TVBox 与前台线路折叠

- 新增 `/sub/<token>.tvbox`，返回 TVBox/FongMi 可用的 live 配置
- 后台订阅页新增「TVBox」复制按钮
- TVBox 配置包含 M3U 地址和 EPG 地址；文件由 runner 在 export/collect 时预生成，缺失时 Worker 即时生成
- 前台频道详情默认只显示前 8 条线路（alive → suspect → dead 排序），dead 默认折叠
- 新增「显示全部 N 条（含 dead）」/「只显示前 8 条」切换
## 2026-10-29 源健康与别名冲突

- 新增 `GET /api/admin/sources/health?days=7`，读取已有 `source_stats` 日表
- 采集站页展示每个源近 7 天「可用 / 解析」和百分比，失败显示红色
- 新增 `GET /api/admin/channels/alias-conflicts`：同一归一化别名指向多个频道时返回冲突
- 频道管理页新增「别名冲突」按钮与审查 Sheet，当前检测到 23 组
- 冲突只展示，不自动修改；合并仍需人工确认
## 2026-10-29 冲突合并结果

- 23 组同名重复全部合并，当前别名冲突 **0**
- 频道表：1108 → **1085**
- 线路：2823 → 2808（同 URL 去重后减少）
- 可用：841 → 838
- 例：BRTV 北京卫视合并后 2 条线路，万州综合频道 3 条
## 2026-10-29 参考项目评审与 YSP 接入

- 接入 `https://petem379-cmd.github.io/ysp/all.m3u` 作为「央视频 YSP 静态源」
- 62 路，第一次探测 52 路可用；CCTV1 实测 1080p / 25 Mbps
- 刷新间隔 1 小时；上游 GitHub Pages 自动刷新播放列表
- 已写入 `0008_ysp_source.sql`，新部署自动带上
- 其余参考项目结论：
  - ysp-live / ysp-live-go：YSP 协议网关，需要自建 Python/Go 服务，不适合直接跑在 Worker
  - china-live：多 provider 兜底 + 7 天回看 + EPG 聚合，可作为后续 catch-up/EPG 参考
  - akiralereal/iptv：GPL-3.0，功能全但代码不能直接搬；参考频道分类和 GUI
  - IPTV-PHP-Wasmer：Wasmer Edge PHP 代理，参考 80s 流缓存和 cKey/TEA，不适合 Cloudflare
  - CCTVLiveRelay：headless Chromium + FFmpeg 捕获，必须有状态服务器，不适合边缘
## 2026-10-29 EPG 多源聚合结果

- 三个 EPG 源全部成功：
  - fanmingming: 128 频道 / 36,900 节目
  - epg.pw: 539 频道 / 36,636 节目
  - zsdc: 128 频道 / 36,900 节目
- 合并去重后：583 频道 / 24,570 节目
- 每订阅 EPG gzip 后仍约 **345 KB**
- YSP 静态源的 `playseek` 参数被 GitHub Pages 忽略，当前不能做回看；需要 ysp-live 网关才有真实 7 天时移
- 如果以后部署 ysp-live/ysp-live-go，可作为独立回看源接入
## 2026-10-29 EPG 准确性修复

- 问题：多 XMLTV 源存在几秒到几分钟的 start 偏差，CCTV 官方 EPG 只覆盖完全相同的 start，导致旧节目残留并显示错误的“正在播出”
- 修复：
  - CCTV 官方覆盖的频道，先删除所有 XMLTV 节目，再写入官方节目单
  - XMLTV 同频道节目按 start 分钟去重，避免多源重复/重叠
- 验证 CCTV1：11:47 非遗里的中国-MV，11:53 秘境之眼，12:00 新闻30分，与官方接口一致
- EPG 体积仍约 345KB gzip
## 2026-10-29 KV 分桶优化与 EPG 覆盖率

- 频道分片从 64 桶改为 16 桶，单次发布最多少写约 48 个 KV 对象
- Worker 读取时保留旧 64 桶回退，迁移期间频道详情不会 404
- 修复测试中的旧桶断言；Deploy 已恢复正常
- 新增 `GET /api/admin/epg/coverage`
- 当前 EPG 覆盖率：209 / 1089（19%），缺 880 个频道；原始 XMLTV 覆盖 583 个 ID，但很多本地 x- 频道没有对应节目单
- 概览页新增 EPG 覆盖率卡片
- 今日 KV 写入已到 772/1000，暂不跑采集/导出；分桶优化需下次发布验证
## 2026-10-29 EPG 映射增强

- 新增 epg.pw 数字 ID → 标准频道名映射（59 条，来自 china-live 的公开映射）
- `matchEpg` 现在会尝试频道的全部 display-name，并优先选择已有频道而不是新建 x-
- epg.pw 源自动套用 ID 映射
- 由于今天 KV 已用 772/1000，未跑采集；覆盖率提升需明天第一次采集后验证
## 2026-10-29 KV 保护与 EPG 映射工作台

- 后台触发 collect/export 前读取用量快照；KV 写入 ≥920/1000 时直接拒绝，850 以上返回警告
- 频道管理页新增「EPG 映射」面板：列出缺失频道的名称/ID，支持搜索和逐个绑定 EPG 显示名或数字 ID
- 绑定写入别名表，下一轮采集时 EPG 匹配生效
- 新增 epg.pw 数字 ID 映射，matchEpg 会尝试全部 display-name 并优先已有频道
## 2026-10-30 待验证清单

1. EPG 覆盖率是否从 19%（209/1089）上升；epg.pw 59 条 ID 映射和手动绑定是否生效
2. 单次采集 KV 写入是否因 16 桶分片明显下降
3. 频道详情在 16 桶布局下是否正常，旧 64 桶回退是否有效
4. CCTV1 节目单是否仍与官方接口一致，XMLTV 重复是否消失
5. KV 写入保护：达到 920 后 collect/export 是否返回 429
6. 手动绑定的 EPG 别名在下一轮采集中是否被使用