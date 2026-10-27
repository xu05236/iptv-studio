# 架构

## 两条执行平面

```
┌────────────────────────────── GitHub Actions ──────────────────────────────┐
│ collect.ts                                                                  │
│  1. GET /api/admin/{settings,sources,channels,aliases,rules}                │
│  2. 抓取每个源（ETag/304）；解析 m3u/txt/json/tvbox/hwctc                    │
│  3. registry.resolve(name, tvgId) → 频道身份                                │
│  4. 与 state/lines.json 合并，保留 firstSeen/失败计数/上次测速                │
│  5. planProbes() 选预算内的线路 → probeStream() → transition() → scoreLine() │
│  6. collectEpg() → merge → XMLTV                                             │
│  7. buildArtifacts() → catalog / index / 分片 / guide                        │
│  8. publish() 上传 KV；sync/channels + sync/sources 写 D1                         │
│  9. diffCatalogs() → Telegram；POST /api/admin/runs                          │
└────────────────────────────────────┬────────────────────────────────────────┘
                                     │ HTTPS（admin artifact API）
┌──────────────────────────────── Cloudflare ─────────────────────────────────┐
│ Worker (Hono)                                                               │
│  /sub/:token.m3u|txt|json  从 out/catalog.json 实时过滤 → 字符串 → ETag/304   │
│  /epg/:token.xml           KV out/epg.xml                                   │
│  /api/public/*             索引缓存 30s；频道分片按需读                       │
│  /api/admin/*              Bearer 会话或 service token                       │
│  /relay                    可选 HLS 中继（默认关闭）                          │
│  cron 每小时               清理运行记录、标记失联源、按保留期删快照             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**职责边界**：任何需要 CPU 或带宽的判断都在 Actions；Worker 只做鉴权、过滤、字符串拼接与缓存。
这样免费额度不会被测速打穿，也让「没有服务器」成为可持续方案。

## 数据流中的身份

```
Source ──(url)──▶ RawEntry ──resolve()──▶ LineEntry ──dedupe()──▶ Channel ──filter──▶ Subscription
  id                name/url/headers         channelId/urlKey       id/别名           分组/清晰度/速率
```

- **LineEntry.key** = `hash(sourceId + 规范化 URL)`，用于跨运行继承测速历史。
- **去重键** = `channelId + urlKey`，不区分 source：两个订阅里的同一条 CCTV-1 只保留评分最高的一条。
- **urlKey** 会丢弃 `token/expires/sign/ts` 等会话参数、排序 query、统一默认端口，避免同一路流因 token 轮换被当成新线路。

## 存储布局

### D1（可编辑状态，低频写）

| 表 | 用途 |
| --- | --- |
| `sources` | 源地址、启用、优先级、地区、ETag、信誉分、连续失败数 |
| `source_stats` | 按天的抓取/存活/速率统计（趋势图） |
| `channels` | 频道身份、分组、tvg-id、台标、启用、排序 |
| `aliases` | 别名 → 频道 id（频道合并的落点） |
| `subscriptions` | 订阅过滤器、token、格式 |
| `rules` | 声明式过滤/分类规则 |
| `runs` | 每次运行的摘要与日志指针 |
| `feedback` | 众包报错 |
| `settings` | 单个 JSON blob（AppSettings） |
| `audit` | 管理操作审计 |

### KV（产物，高频读）

| Key | 内容 |
| --- | --- |
| `out/catalog.json` | 导出用目录：频道 + 已排序的候选线路 |
| `out/epg.xml` | 合并后的 XMLTV |
| `state/index.json` | 频道索引（列表页、统计） |
| `state/bucket/<n>.json` | 64 个分桶，每桶约 30 个频道的线路 + 今明节目（避免 KV 写放大） |
| `state/lines.json` | 全量线路状态（下一轮继承用，含 dead） |
| `state/prev.json` | 上一次目录（diff 基线） |
| `state/guide.json` / `state/now.json` | 24h 节目表 / 正在播出 |
| `shots/<channelId>.jpg` | 可用频道的首帧截图（可选，320px） |
| `snapshots/<date>/catalog.json` | 快照，保留 7 天 |
| `logs/<date>/<runId>.jsonl` | 结构化运行日志 |

> 为什么目录和分桶分开：列表页需要轻量索引，详情页需要完整线路；把 2000 个频道塞进一个 JSON 会让
> Worker 每次请求都解析几 MB。分桶把解析成本压到百 KB 级，同时把 KV 写入控制在每天约 70 次
> （KV 免费额度 1000 次/天）。

## 测速（核心）

`probeStream()`：

1. 非 HTTP 协议（RTSP/RTMP/UDP/RTP）直接返回不可判定，状态保持不变，不消耗预算。
2. `Content-Type`/URL/首块内容任一命中 HLS → 走 `probeHls()`。
3. HLS：拉 master → 选 `BANDWIDTH` 最高档 → 拉子 playlist → 取首个分片实际下载；
   从 `RESOLUTION/FRAME-RATE/BANDWIDTH` 得到分辨率与码率；`ENDLIST + 时长 < 300s` 标记循环流。
4. 直链：GET + `Range`，读流过程中**丢弃前 512KB**，再采样 1.5s 计算稳态速率：

```
speed = 采样字节 × 8 / 采样毫秒   (kbit/s)
```

这样「开头 20Mb/s、两秒后卡住」的源不会拿到高分。

## 线路状态机

| 事件 | 结果 |
| --- | --- |
| 成功 | `alive`，failCount=0，reviveAt 清空 |
| 失败 1 次 | `suspect`，failCount=1，**不进入订阅** |
| 失败 2 次 | `suspect`，仅在频道无 alive 时兜底 |
| 失败 3 次 | `dead`，设置 `reviveAt = now + 14d` |
| dead 到期 | 重新进入测速计划，成功则复活 |
| dead 超过 90 天 | 季度清理（不再探测/保留） |

`shouldExport()` 决定是否出现在播放列表；`planProbes()` 决定是否今天探测：
从未测过 > 到期复活 > suspect > alive，按源的 tier 给 TTL（12h / 72h / 168h）。

## 排序与信誉

```
score = 100 × (0.40·速度 + 0.24·清晰度 + 0.14·稳定性
             + 0.10·源信誉 + 0.07·协议 + 0.05·新鲜度) × 循环流惩罚
```

- 速度：以 100kbps→0、8Mbps→1 的对数映射；
- 清晰度：2160p=1、1080p=0.72、720p=0.52、unknown=0.35；
- 源信誉：`0.65·旧值 + 0.35·(0.72·可用率 + 0.28·平均分)`，抓取失败再打折。

聚合时先按 score 排序，再限制「单源最多 2 条 + 每频道最多 6 条」，
避免一个高产源垄断整个频道，也让不同 CDN 的线路都有机会。

## 频道归一化

1. NFKC + 繁转简 + 全角转半角 + 去括号噪声（`[1080P]`、`(高清)`），保留 `(欧洲版)` 这类语义限定；
2. 精确别名 → tvg-id → CCTV 正则（`cctv5+`、`cctv4k`）→ 中央N台 → 模糊匹配（Dice ≥ 0.86）→ 新频道；
3. 新频道写回 D1，下一次运行即可复用；管理员手动添加的别名优先。

内置约 180 个频道种子（CCTV 全系、31 个卫视、港澳台、地方、付费、4K），
其余频道依赖 EPG 的 `display-name` 与来源名称自动生长。

## 缓存与一致性

- 订阅：`ETag = W/"<catalog.runId>-<订阅配置指纹>"`，命中返回 304；响应 `max-age=60, s-maxage=300`。
- 公共列表：`Cache-Control: public, max-age=30`；索引直接读 KV。
- 频道详情：读取对应分桶（约 30 个频道），解析百 KB 级 JSON，CPU 远低于免费版 10ms 限制。
- 订阅：内容由 runId 决定，ETag + Cache API 命中时不再读 KV。
- D1 是配置的唯一真相；KV 目录是「最近一次运行的结果」。两者通过 `sync/*` 接口对齐，
  管理端修改（禁用频道、加别名、改订阅）立即生效，无需等下一轮采集。

## 安全

| 面 | 措施 |
| --- | --- |
| 管理鉴权 | `ADMIN_TOKEN` 仅用于登录换取 7 天 HMAC 会话；runner 用 `x-admin-token` 直连 |
| 暴力破解 | 登录按 IP 计数（KV，10 分钟窗口，8 次上限） |
| SSRF | 所有远程源/探测地址校验 http(s) 且拒绝内网、回环、链路本地、云元数据地址 |
| 注入 | 全部 SQL 使用 D1 prepared statement；导出对引号/换行做转义 |
| 订阅泄露 | 每个订阅独立 token，可一键轮换；不暴露源地址以外的管理数据 |
| 视频中继 | 默认关闭，需订阅 token + 手动开启；文档明确提示 Cloudflare 条款风险 |

## 已知技术债

1. 非 HLS 分辨率缺失：需要 ffprobe 或解析 TS/PMT，当前留空而不是猜。
2. 反馈未进信誉分：`feedback` 已落库并在后台展示，评分只用了测速结果。
3. 规则只有 API，没有可视化编辑器。
4. 快照可查不可一键回滚（需手动复制 `snapshots/<date>/catalog.json`）。
5. 单机 Actions 出口，无法表达「江苏电信 vs 江苏联通」；需要 self-hosted runner 矩阵。
