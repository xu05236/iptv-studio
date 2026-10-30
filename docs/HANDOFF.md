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
## 2026-10-29 EPG 映射工作台补全

- 覆盖率接口支持 `q/limit/offset`，可搜索全部缺失频道，不再只返回前 100
- EPG 映射面板支持分页加载更多
- 截图：频道管理 → EPG 映射
## 2026-10-29 纯代码收尾

- Dashboard 增加 KV 写入预警；≥850 橙色提示，≥920 禁用采集/导出按钮
- 新增 `GET /api/admin/backup`，可导出 settings/sources/channels/aliases/subscriptions JSON
- 概览页新增「备份」按钮
- 采集站支持按近 7 天健康度排序
- EPG 覆盖率接口支持搜索和分页，映射面板可加载更多
## 2026-10-29 EPG 源管理 UI 与移动端收尾

- 设置页 EPG 改为源列表管理：逐条编辑、删除、添加，保存后下一轮采集生效
- 支持添加多个 XMLTV 源（含 .xml.gz）
- 播放器新增全屏按钮，兼容 requestFullscreen 与 iOS webkitEnterFullscreen
- 移动端播放器圆角/按钮位置调整
- 频道详情线路操作按钮支持换行；EPG 映射行在窄屏可换行
## 2026-10-30 明日执行清单

### 08:30 定时采集后

1. 确认 Collect & Probe 成功，频道/线路/可用数
2. 查看用量快照：KV 写入是否明显低于上次 60-100 次/轮
3. 检查 EPG 覆盖率是否高于 209/1089；epg.pw 59 条 ID 映射和手动绑定是否生效
4. 打开 CCTV1 频道详情，核对当前节目与官方接口一致
5. 打开任意频道详情，确认 16 桶分片 + 旧 64 桶回退正常
6. 检查 EPG 每订阅 gzip 文件是否仍然生成、大小正常

### 额度保护

- 若当天 KV 写入达到 920，手动 collect/export 应返回 429
- 定时采集已从 00:00 挪到 08:30（UTC 00:30），在额度重置后运行

### 后续可选

- EPG 缺失映射批量导入/按分组处理
- 源健康排名/自动降权
- YSP 回看需要自建 ysp-live 网关，暂缓
## 2026-10-29 取消每源条数上限

- 移除全部采集站的 `maxEntries`（包括 all-7990），不再在导入时截断线路
- 线路质量交给探测与导出：新线优先、3 次失败淘汰、14 天复活、频道内按分辨率/速率/评分筛选
- 单轮探测仍受 6000 条/次预算保护；长源会在后续几轮逐步测完，避免 Actions 超时和分钟数失控
## 2026-10-29 探测速度与 Actions 额度优化

- 可用线路复测：24h → **72h**
- 精品线路复测：72h → **7 天**
- 探测并发：32 → **64**
- 新增环境变量 `PROBE_ALIVE_HOURS` / `PROBE_PREMIUM_HOURS`，默认 72 / 168
- 单轮仍保留 6000 条预算，但到期探测数量会明显减少，Actions 时间随之下降
- 源导入不设条数上限；线路靠多轮探测逐步淘汰，而不是导入时截断
## 2026-10-29 探测策略最终参数

- 每频道每轮最多探测：**24 条**
- 可用线路复测：**15 天（360h）**
- 精品线路复测：**7 天（168h）**
- 单轮总预算：6000
- 导入不限条数；未测线路保留，后续轮次轮换
- 探测前按分辨率线索、源信誉、历史分数、新线优先排序
- 预期：单轮探测数大幅下降，Actions 时间下降，但新源首次覆盖会分多轮完成
## 2026-10-29 自适应复测间隔

- 新增 `passCount`：探测成功 +1，失败清零
- 精品线路首次 7 天；每次通过 +3 天，上限 30 天
- 可用线路首次 15 天；每次通过 +3 天，上限 30 天
- 未通过或从未通过的线路仍按状态机处理（3 次失败 dead，14 天复活）
## 2026-10-29 取消自动采集

- `collect.yml` 已移除 schedule，仅保留 workflow_dispatch 手动触发
- 不再自动抓源/测速；何时采集由人工决定，避免占用额度和影响试验
- 线路池开发必须复用现有频道结构：
  - `countryOfGroup` / `/api/admin/channels/meta/tree`
  - `group_title` / 频道 `name` / `tvgId`
  - 不硬编码“央视→CCTV1”等示例层级
- 原 08:30 验证计划改为“手动触发后验证”
## 2026-10-29 线路池 Phase 1

- 源列表新增进度：总数 / 已测 / 可用 / 待测 / 待复测 / 淘汰
- 新增 `GET /api/admin/pool/tree`：沿用现有国家/分组/频道结构
- 新增 `GET /api/admin/pool/lines`：分页 + 分组/频道/池/分辨率/速度/直连中继/关键词筛选
- 新增后台「线路池」页面（只读）
- 池类型当前按状态推导：每频道前 12 条为 premium，其余 alive 为 backup，未测 pending，suspect 待复测，dead 淘汰
- 本轮只读，不改线路状态，不产生 KV 写入
## 2026-10-29 线路池 Phase 2

- D1 新增 `line_overrides`，人工池决策不重写线路状态
- 池 API 现在返回 `pool`（最终）、`autoPool`（自动推导）、`overridden`、`reason`
- 新增 `POST /api/admin/pool/override` 和 `POST /api/admin/pool/reset`
- 后台线路池支持单条/批量移动、标记淘汰、恢复自动
- 测试：把一条 quarantine 线路移到 backup，再恢复自动，接口均成功
- 修复 `channelAliases` 查询漏绑定 channelId 的旧 bug
- 自动采集仍关闭；本阶段只写 D1，不消耗 KV
## 2026-10-29 线路池导出

- 新增 `POST /api/admin/pool/export`：按当前筛选或勾选 keys 生成 M3U
- 线路池页面新增「导出当前筛选」按钮
- 池视图按 URL 去重，避免同一线路被多个源重复计入精品池
- 验证：CCTV1 精品池去重后 5 条，导出 M3U 200
- 订阅绑定 `line_keys` / `pool_mode` 尚未实现，留到下阶段
## 2026-10-29 线路池自定义订阅

- `subscriptions` 新增 `line_keys` / `pool_mode`
- 线路池页面新增「保存为订阅」：按当前筛选或勾选线路直接生成订阅
- 自定义订阅由 Worker 从 `state/lines.json` 按 line_keys 动态渲染，不依赖 catalog 前几条
- runner 跳过自定义订阅的静态预渲染，避免旧静态文件覆盖动态结果
- 验证：创建 1 条线路的自定义订阅，M3U 正常返回；测试订阅已删除
- 自动采集仍关闭，本阶段只写 D1
## 2026-10-29 收尾 / 2026-10-30 计划

### 当前状态

- 自动采集已关闭，`collect.yml` 仅保留 workflow_dispatch
- 22 个采集站，21 个启用
- 线路池：只读浏览、筛选、导出、人工移动、批量操作、自动晋升
- 自定义订阅：`line_keys` / `pool_mode`，按线路池动态渲染
- 池数据来自上一轮 3310 条线路；17 个新源尚未进入 pending
- KV 写入约 772/1000；今天不再跑采集/导出
- D1 迁移 0010（overrides）、0011（订阅 line_keys）已应用

### 已完成

- 源进度：总/已测/可用/待测/待复测/淘汰
- 线路池：国家/分组/频道沿用现有结构
- 池筛选：池类型、分辨率、速度、直连/中继、关键词
- 人工策略：单条/批量移动、标记淘汰、恢复自动
- 自动晋升：精品不足时从备用池补位，人工移到备用池的线路不补
- 按筛选导出 M3U
- 保存为自定义订阅
- URL 去重

### 2026-10-30 早上（额度 08:00 重置后）

1. 读 HANDOFF，确认最新提交和部署状态
2. 查看用量：KV/D1 是否清零、当前剩余额度
3. 手动触发一次 collect，预算先用 1200，不自动
4. 验证 17 个新源的 pending / 已测 / 可用进度
5. 验证 16 桶分片后的频道详情、KV 写入是否下降
6. 验证 EPG 覆盖率、CCTV1 节目单
7. 验证线路池自动分类、自动晋升、自定义订阅
8. 再决定是否提高预算、继续墓碑清理或拆分 collect/probe

### 仍未完成

- 墓碑自动过期清理
- collect / probe / publish 拆分
- pool 轻量测活
- 订阅 `premium_backup` 模式（当前只有 custom）
- 手动采集后的真实数据验证

> 注意：今天多次出现 DSH `MALFORMED_RESPONSE`，是工具调用 JSON 解析错误，不是项目故障；明天继续时保持一次只做一个小操作。
## 2026-10-29 16:30 最新进度（新对话从这里开始）

### 最新代码

- 最新提交：`04df828`（分页 + 多源台标）
- 已部署并验证：Deploy Worker success
- 自动采集仍关闭，`collect.yml` 只有 workflow_dispatch

### 今天已完成并上线

- 线路池：源进度、只读池、池树、筛选、人工移动/批量移动/恢复自动
- 池自动晋升：精品不足时从备用池补位，人工移到备用池的不补
- 按筛选导出 M3U
- 保存为自定义订阅：`line_keys` / `pool_mode`，Worker 按 key 动态渲染
- D1 迁移已应用：0010 `line_overrides`、0011 订阅 line_keys
- 检测中心分页：默认 10，可选 10/20/30/50/全部，后端 offset 分页
- 线路池、前台频道、后台频道管理：默认 10，可选 10/20/30/50
- 台标多源回退：
  - tvg-logo
  - GitHub raw
  - jsDelivr
  - gcore jsDelivr
  - 首字兜底
- 旧 fanmingming 台标地址在 M3U 生成时自动改用 jsDelivr 镜像
- 修复后台空白：Dashboard 的备份 Hook 原先放在 `if (isLoading) return` 之后，已移到条件返回前

### 当前数据

- 22 个采集站，21 个启用
- `state/lines.json` 约 3310 条（含跨源重复）
- `state/probe.json` 约 2870 条
- 17 个新源尚未进入 pending，等手动采集
- 已发布频道约 1089 个，具体以线上为准
- KV 今日写入约 772/1000，剩余额度不要浪费

### 2026-10-30 早上计划

1. 08:00 后确认 KV/D1 重置，先看后台用量
2. 手动触发一次 collect，预算先 1200，不自动
3. 验证 17 个新源：pending / 已测 / 可用 / 淘汰
4. 验证 16 桶分片的频道详情和 KV 写入是否下降
5. 验证 EPG 覆盖率是否高于 209/1089，CCTV1 节目单是否与官方一致
6. 验证线路池自动分类、自动晋升、自定义订阅和导出
7. 验证后台不再空白，分页/台标正常
8. 再决定是否提高预算

### 仍未完成

- 墓碑自动过期清理
- collect / probe / publish 拆分
- pool 轻量测活
- 订阅 `premium_backup` 模式（目前只有 custom）
- 新源首次全量采集验证

### 新对话接续说明

- 先读本文件，再 `git status` / `git log -3` 确认工作区干净
- 不要自动触发采集；等用户明确说“手动采集”
- 一次只做一个明确小任务
- 不要重复跑部署轮询；CI success 即可
- 若出现 `MALFORMED_RESPONSE`，停止复杂工具调用，改小步

---

# 2026-10-30 上午 · 验证与修复

## 采集与数据

- 08:40 collect（预算 1200，手动）：run `40981115326` 发布成功，状态 partial（9 个源抓取失败）
- 12 个新源成功导入：Guovin、yyfxz×3、all-7990、156.238×2、iptv.445569、gchust、baoyj 等
- 09:07 / 09:15 / 09:22 三次运行非本会话触发（collect → export → collect budget=1）
- 09:15 起公开索引只发布有 alive 的频道（`fb34a7c`）：频道 3389 → **542**
- 当前：频道 **542** / 线路 **2723** / 可用 **787**；EPG 覆盖 **58/542**（有 alive 且能匹配节目单的交集）
- 09:22 的 collect 合并 EPG 588 频道 / 19,235 条节目，guide 数据正常，58 是交集不是丢失
- 已禁用 9 个连续失败的源：140.83、61.160、124.223、124.222、219.146、catvod、jsnzkpg、stymei、paste c-net
- 启用源降为 12 个，全部有线路；下一轮 collect 应为 success

## 本轮修复

- `19b177f` EPG 改为返回原始 XML，由 Cloudflare 压一次；补 `Vary: Accept-Encoding`；runner 不再写 `.xml.gz`（之前是双层 gzip）
- `bac2642` `putArtifact` 用 `getWithMetadata` 代替 `KV.list`；新增单测断言 list=0（lists 1k/天是真正瓶颈）
- `0ca73f5` 后台 KV 卡片和全局告警增加 lists 指标
- `9653aec` 线路池导出用 `channelLogo()` 从 tvg-id 合成台标
- `46e2315` export 不再用 24h guide 重建每订阅 EPG（否则 2.5 天会被截成 24h）
- 非本会话：`43344d1` export 保留 guide（已验证覆盖率不变）、`fb34a7c` 索引只含有 alive 的频道

## 验证结果

- 16 桶分片：`state/bucket/` 只有 0–15 被重写，旧 16–63 未动；抽样频道详情 0 个 404
- CCTV1 当前节目与央视官方接口一致（08:36《生活早参考-特别节目（生活圈）》）；38 条节目 0 重复、0 重叠
- 线路池：premium 474 / backup 1 / pending 4107 / quarantine 1786 / rejected 1423；晋升 0 次（没有缺口）
- 自定义订阅、池导出、分页正常；导出 M3U 已带台标
- export run `40989845454` success；guide 覆盖率保持 58/542
- KV 今日约 161 写 / 139 list / 304 读 / 47 delete；受控测试 3 次上传只 +2 list，list 修复生效

## 待办

- 预算暂不提高（用户决定），pending/quarantine 等下一轮再消化
- 下一轮 collect 验证：源清理后 run 为 success、per-sub EPG 恢复 2.5 天
- 当前 per-sub EPG 是 export 后的 24h 版本，下次 collect 会恢复完整
- P2：墓碑自动清理、collect/probe/publish 拆分、pool 轻量测活、`premium_backup` 模式

## 候选任务（2026-10-30，均不耗采集额度，等用户选择）

1. `premium_backup` 订阅模式：精品优先、备用兜底渲染（目前只有 custom）
2. 墓碑自动过期清理：dead 线路按天数自动删除，下轮发布生效
3. EPG 映射批量导入/按分组：补 484 个缺节目单的 alive 频道，只写 D1
4. 清理旧 64 桶 key：48 次 KV delete，释放存储（16 桶已完整）
5. 前端体验：频道详情、订阅页、移动端
6. **卫视/地方台 EPG 官方源适配器（ROADMAP P2-1）**：湖南 / 浙江 / 江苏 / 东方 / 北京，复用 `core/src/epg/cctv.ts` 的 `parseXxxEpg + runner 抓取` 模式；先做 3–5 个台验证收益。**优先级放最后（用户 2026-10-30 决定，仅登记防遗忘）**

> 用户决定：暂不提高预算、暂不跑 collect；先做上面这些不耗额度的任务。

---

# 2026-10-30 中午 · EPG 批量映射 / D1 清理 / 线路池

## EPG 批量映射（5f9353c）

- `/api/admin/epg/coverage` 支持 `group` 过滤
- 新增 `POST /api/admin/epg/bind-bulk`（最多 500 条，校验频道/别名归属，D1 批量写入）
- 后台「EPG 映射」加分组 chip + 批量粘贴（`频道ID => EPG名`）+ 填入当前列表
- 实测：缺失 484，`group=央视` 只剩 1；绑定/删除测试通过

## D1 空频道清理

- `cleanup-empty`：删除 3751 个，保留 712（542 个发布频道 + 170 个有手工别名）
- 发布索引仍 542

## 线路池（87fe4f4）

- 新增 **candidate** 池：alive 但分辨率未知（测活通过、质量待确认），不计入 premium
  - 当前 candidate 21 条；premium 474 → 454；backup 0
  - 口径说明：按“分辨率未知”定义；若按“只测过 1 次”定义会接近全部（数据里 passCount 多为 0/1）
- `/pool/lines` 支持 `subscriptionId`：按订阅的 line_keys / channel_ids / groups 过滤
  - 实测临时订阅（cctv1）42 条，筛选结果 42/42
- 频道筛选改为全局可搜索（datalist），不再只能选当前分组
- 速度筛选统一为 Mbps（表格本来就是 Mb/s）
- 移动/恢复自动沿用 override，已验证 candidate → backup → reset
- 池视图隐藏 D1 已删除的孤儿频道（3235 → **698**），新增「来源站」筛选（查看/导出/保存订阅），池顺序按生命周期重排并显示计数
  - 隐藏孤儿后池总量：premium 454 / candidate 21 / pending 977 / quarantine 924 / rejected 635（孤儿线路仍在 state，但无频道身份、不可发布）

## 未完成

- 删除 / 墓碑：需要 D1 `line_tombstones` 表 + runner 导入过滤 + 后台按钮
- candidate 需要 ffprobe 测出分辨率后才会进 premium
- **卫视/地方台 EPG 官方源适配器（ROADMAP P2-1）**：CCTV 已接 CNTV JSON；卫视/地方台仍全靠 XMLTV，候选湖南/浙江/江苏/东方/北京，接口不公开、湖南需签名，先做 3–5 个台

## 上个会话遗留清单核对（2026-10-30 中午）

- P0：guide 58 频道 / 772 条节目，coverage 58/542，最新 export `run-mvuc1sra-4pgn` success；HANDOFF 已补
- EPG 从 98 → 58 是索引 3389 → 542 后的交集变化，不是 guide 丢失或 buildGuide 丢数据
- 索引过滤 `stats.alive === 0`（publish.ts:107）会**有意排除**只有 suspect 的频道；是否保留“暂不可用”频道待产品决定
- 17 个新源：12 个启用源全部有线路，9 个失败源已禁用；pending 4107 / quarantine 1786 / rejected 1423
- P2 剩余：删除/墓碑、collect/probe/publish 拆分、pool 轻量测活、卫视/地方台 EPG 适配器（premium_backup 已完成）

---

# 2026-10-30 中午 · 池驱动订阅

## 实现

- core 新增 `linePool.ts`：`buildPoolSnapshot()` / `dedupePoolLines()`
  - 快照只保留测活通过的线路，按频道分 premium / backup / candidate
  - 同一 URL 按 canonical URL 去重，优先 alive、再按最近探测时间；修掉了 `//host` 与 `http://host` 两种 urlKey 导致池里留下未测重复线的问题
- runner 在 collect / export 发布时写 `state/pool.json`（约 500KB），不再预渲染 premium/premium_backup 订阅
- Worker `renderSubscription`：premium / premium_backup 从快照渲染，并实时应用 `line_overrides`
  - premium = 只用精品；premium_backup = 精品不足时用备用补位
  - 预渲染文件在池模式下被忽略，避免旧文件覆盖 override
- 订阅页新增「线路池模式」选择（精品池 / 精品 + 备用兜底），列表显示模式徽章
- 修复 `updateSubscription` 只认 snake_case 的问题（camelCase 编辑之前会被静默忽略）

## 验证

- 池 premium 从 454 升到 **732**（去重后保留 alive 记录）；tree 704 频道
- 现有「全部频道」订阅 M3U 609 条，头注释来自池渲染；override 一条到 backup 后该 URL 立即消失，恢复后回来
- 临时 premium_backup 订阅（央视、每频道 2 条）29 条 M3U，创建/编辑/删除正常
- 当前 `state/pool.json` 是本地按最新 state 生成的；下一轮 collect/export 会由 runner 自动重写

## 备注

- 池视图/快照现在都以「canonical URL + 优先 alive」去重，池 totals 与快照一致
- 待办：删除/墓碑、线路留存、预算公平、pool 测活