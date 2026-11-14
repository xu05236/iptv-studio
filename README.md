# IPTV Studio · 云视

**Cloudflare 原生的 IPTV 采集、测速、聚合与订阅平台。**
重活交给 GitHub Actions，分发与状态交给 Cloudflare：不需要 VPS，不需要常驻服务器。

```
源（M3U/TXT/JSON/TVBox/华为）
        │  Actions 每日抓取（ETag/304）
        ▼
   解析 → 频道归一化 → 去重 → 稳态测速 → 状态机 → 信誉分
        │                                         │
        │ 聚合（按频道合并线路）                    │ 差异对比 / Telegram 日报
        ▼                                         ▼
   KV（catalog / 分桶 / EPG / 快照 / 日志）
        │
        ▼
   Worker（Hono + D1 + KV + Cache）
        ├── /sub/<token>.m3u|txt|json   订阅出口（ETag、304、边缘缓存）
        ├── /epg/<token>.xml            节目单出口
        ├── /api/public/*               前台只读 API
        ├── /api/admin/*                Token 保护的管理 API
        └── /                           React（iOS 风格）前台 + 后台
```

## 这个项目解决什么

国内 IPTV 源的特点是：**多、乱、短命**。同一路 CCTV-1 可能来自五个订阅、十几个 CDN、每天失效一批。
通用做法是拿一个脚本跑一遍输出 m3u，但很快会遇到四个问题：

1. 失效线路越来越多，播放器里全是黑屏；
2. 同一频道重复几十条，排序靠运气；
3. 测速只看「能不能连」，不管稳态速率和分辨率；
4. 没有任何历史与可观测性，坏了不知道坏在哪。

IPTV Studio 把这条链路做成了**有状态的数据管道**：
每条线路有生命周期（alive → suspect → dead → 14 天后复活 → 季度清理），每个源有信誉分，
每次运行有快照与结构化日志，订阅出口按频道合并去重后实时生成。

## 功能

| 模块 | 能力 |
| --- | --- |
| 采集 | M3U / TXT / JSON / TVBox `lives` / 华为 JSP 自动识别；订阅 URL、文件上传、文本粘贴三种入口；ETag/Last-Modified 条件请求；**备用地址链**（主地址失败自动换备用）；源级请求头（UA/Referer/Cookie）与抓取方式（直连 / Worker 代拉）；按源超时、镜像并发、请求前延迟；GBK/Big5/BOM 编码识别；解析诊断（条目数/大小/编码/警告/条数骤降标红）；单源失败不影响其他源；合并频道（按平台/直播源合并）；纯数字频道名过滤（默认开） |
| 检测 | HTTP 连通性、TTFB、**丢弃 512KB 预热后的稳态速率**、HLS master 解析分辨率/帧率/码率、广告循环流识别、检测时间落库 |
| 状态机 | 新线路失败 1 次进「待复测」，复测一次仍失败即「已淘汰」终态；曾可用线路连续 3 次失败进终态；已淘汰保留 30 天用于重抓去重、不再自动探测，可手动复活或月末抽检；采集站连续失败自动降级/暂停，可在后台「恢复」 |
| 聚合 | 按归一化频道合并多订阅线路；URL 归一化去重；速度/分辨率/稳定性/信誉加权排序；单源配额保证多样性 |
| 频道 | 内置 CCTV / 卫视 / 港澳台 / 地方 / 付费 / 4K 别名库；`CCTV1`、`CCTV-1 综合`、`中央一台` 归一；支持自定义别名与合并 |
| EPG | 多 XMLTV 源合并 + CNTV/央视官方 JSON 回退；按 `tvg-id`/别名匹配；覆盖率按「有未来节目」计算并提示节目单过期；未映射频道工作台（一键绑定/清理噪声）；源优先级（同频道同一时刻靠前优先）与每源贡献统计；订阅 EPG 按需瘦身 |
| 导出 | M3U（含 tvg-* / catchup / EXTVLCOPT 请求头）、M3U Plus、TXT（DIYP/TVBox）、JSON、DIYP JSON；EPG 独立导出 |
| 订阅 | 按分组/频道/分辨率/速率/协议过滤，每频道线路数、地区后缀、ETag/304、边缘缓存；三种代理模式（直连 / 仅清单代理 / 全部中继，中继地址签名绑定订阅 token，按 token 日配额）；合并频道导出（跟随 / 不导出 / 只导出）与独立条数上限；「包含国内可达线路」开关；设备令牌（同一订阅多设备、可单独禁用、显示 24h/7d 活跃）；中继用量按设备/日统计（5 分钟批量落库）；每轮采集预渲染或由 Worker 动态渲染 |
| 前台 | 首页概览（五卡、分类、最近运行）、频道详情（线路序号与默认排序说明、`#1` 首选、台标供体）、HLS 播放（H.265/协议/中继失败提示）、订阅与分类浏览 |
| 运维 | 每日 Telegram 日报、diff（频道增减/失效突增）、运行历史、快照与回滚、运营事件（前台报障 / 后台审计 / 失败原因聚合 TopN）、频道编排（拖拽排序、批量改名/隐藏、分组整组启用/禁用）、规则命中预览 + 线路级预览、失败错误归类、任务与运行记录一致、线路状态分片（manifest + 8 个 gzip 分片）、容量护栏（15MB 告警 / 22MB 拒发）、归档回读（恢复为待测）、大产物流式读取、任务锁续租、合并运行中保护、探测按 URL 去重（同 URL 只测一次并回填）、EPG 排除分组与宽松匹配、EPG 自动建议、探测后自动发布（完成即触发，间隔 0 不限制）、名称即频道与自动补建、规则线路分组匹配、分类同步、D1/KV 写入去重（频道同步哈希跳过）、代理订阅（链接/文件、定时自动刷新、删除时可选保留节点）、国内代理（导入/测活/设为当前/通过代理拉订阅；内核节点 ss/vmess/vless/trojan/hy2/tuic 由 mihomo 支持，失败可串前 3 个国内中转）、国内补测与定时测活、任务名映射统一、源重叠统计、池快照/线路骤降告警、统一查询错误态、用量快照 Worker 内刷新（每小时）、CI 测试+类型检查门禁与部署后 smoke、迁移自检与 `/api/version` |
| 安全 | 管理令牌 + HMAC 会话、登录限流、SSRF 防护、可选 Cloudflare Access、可选 HLS 中继（默认关闭） |
| 界面 | React 19 + 手写 iOS 设计系统：大标题、毛玻璃、分组列表、底部 Tab、明暗主题、移动端优先 |

完整的需求对照（含未完成项）见 [docs/FEATURES.md](docs/FEATURES.md)。

日常运维（自定义池、导出预览口径、合并撤销、容量归档与回读、源重叠、监控告警、CI 门禁、e2e 冒烟）见 [docs/OPERATIONS-2026-11-10.md](docs/OPERATIONS-2026-11-10.md)；管理令牌轮换见 [docs/ADMIN-TOKEN-ROTATION.md](docs/ADMIN-TOKEN-ROTATION.md)（中英文）。

## 快速开始（本地）

```bash
npm install
npm run db:migrate:local          # 建表 + 两条示例源
cp packages/worker/.dev.vars.example packages/worker/.dev.vars
npm run build                     # 先构建前端（Worker 静态资源目录）
npm run dev                       # Worker :8787 + Vite :5173
```

打开 <http://127.0.0.1:5173>，管理后台 <http://127.0.0.1:5173/admin>，令牌为 `.dev.vars` 里的 `ADMIN_TOKEN`。
本地没有部署好的 Worker API 时无法跑完整采集，但可以添加源、解析、单条探测、创建订阅。

## 部署（生产）

五步，详见 [docs/DEPLOY.md](docs/DEPLOY.md)：

1. `wrangler d1 create iptv-studio` + `wrangler kv namespace create KV`，把 id 填进 `packages/worker/wrangler.jsonc`；
2. `wrangler secret put ADMIN_TOKEN` / `SESSION_SECRET`，`npm run db:migrate`；
3. `npm run deploy`（构建前端并部署 Worker，静态资源同一域名）；
4. 在 GitHub 仓库配置 Actions secrets：`API_BASE_URL`、`ADMIN_TOKEN`；配置 `PUBLIC_BASE_URL` 变量；
5. 后台点「立即采集」，或等每天 00:00（Asia/Shanghai）的定时任务。

## 仓库结构

```
packages/core    纯 TS 领域库：解析、归一化、探测、状态机、聚合、EPG、导出、diff、规则
packages/worker  Cloudflare Worker：Hono API、D1、KV、Cron、鉴权、订阅分发
packages/runner  Node 采集器：抓取 → 测速 → 聚合 → 上传 KV → 同步 D1 → 通知
apps/web         React 前台 + 管理后台（Vite，构建产物由 Worker Assets 托管）
migrations       D1 表结构与种子数据
docs             部署、架构、功能对照
```

## 常用命令

```bash
npm run typecheck        # 四个 workspace 全量类型检查
npm test                 # core 单元测试（解析/归一/状态机/排序/导出）
npm run build            # 前端生产构建
npm run deploy           # 构建 + wrangler deploy
npm run collect          # 本地跑采集（需要 .env 中的 API / ADMIN_TOKEN）
npm run export           # 不测速，仅按最新状态重建产物
```

## 设计取舍

- **为什么不在 Worker 里跑全量测速**：Workers 有 CPU/子请求限制，且大量视频探测会把免费额度打穿。
  Actions 负责重计算，Cloudflare 只做状态与分发，这也是 `laobaiepg` 验证过的范式。
- **为什么用 KV 存目录而不是每次查 D1**：订阅是高频读，D1 是低频写。目录、分桶与每个订阅的播放列表
  在采集结束时预渲染，Worker 只做鉴权与流式返回；ETag 命中时零 CPU。
  （新建订阅尚未预渲染时会走一次实时渲染兜底，之后点「重建导出」即可落到静态文件。）
- **为什么没有用 jsDelivr/ghproxy**：第三方镜像随时停摆且不可控。Actions 拉取 → 自有 KV → 自有域名，
  国内访问走 Cloudflare 边缘缓存，链路可控。
- **为什么默认关闭视频中继**：用 Worker 代理视频流量处于 Cloudflare 条款灰区，且成本不可控。
  只把它作为「浏览器预览」的可选项。

## 已知限制

- 非 HLS 源的分辨率无法在无 ffmpeg 环境精确获取；HLS 依赖 master playlist 的 `RESOLUTION`。
- RTSP/RTMP/UDP 组播无法从 HTTP 运行时探测，会标记为「未测」，需要本机 ffprobe 扩展。
- GitHub Actions 出口在海外，无法代表电信/联通体验；地区字段目前靠源标注与人工维护。
- 截图验证（ffmpeg 截帧）与快照一键回滚尚未实现，见路线图。

## License

MIT
