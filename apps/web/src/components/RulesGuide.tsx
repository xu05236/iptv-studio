import type { ReactNode } from 'react';
import { REPUTATION_RULE } from './ReputationBadge';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <div className="title-3" style={{ marginBottom: 6 }}>{title}</div>
      <div className="caption" style={{ lineHeight: 1.7 }}>{children}</div>
    </section>
  );
}

/**
 * Shared rule book for admin and public pages. Keeping it in one component
 * prevents the explanations from drifting apart.
 */
export function RulesGuide({ scope = 'admin' }: { scope?: 'admin' | 'public' }) {
  return (
    <div className="stack" style={{ gap: 16 }}>
      <Section title="信誉分（0–100）">
        <p>{REPUTATION_RULE}</p>
        <p>
          信誉分由抓取成功率、可用线路占比、平均线路质量和连续失败次数共同决定，不是线路数量。
          分数低的源会排在后面、分到更少的完整测速预算；连续失败达到 5 次会自动删除该采集站，避免长期占位。
        </p>
        <p>
          后台可以手动「收藏」采集站（权重 ×2）。收藏源排在最前面，它提供的线路在频道排序和导出时也会更靠前。
        </p>
      </Section>

      <Section title="线路状态与线路池">
        <p>
          每条线路会经历：待测（pending）→ 可用（alive）→ 可疑（suspect）→ 失效（dead）。
          一次失败只先进入可疑；连续 3 次失败才判定失效。可疑线路约 12 小时后会再次进入复测，
          不会因为一次抖动被永久搁置。
        </p>
        <p>
          线路池分为：精品（premium）、备用（backup）、候选（candidate，可用但质量未确认）、
          待测（pending）、隔离（quarantine，近期失败）、淘汰（rejected，失效）。
        </p>
        <p>
          线路池里可以给单条线路点星「收藏」。收藏线路会在频道线路列表和播放器导出中优先排序，
          适合你逐条实测后标记“这条好用”。
        </p>
        {scope === 'admin' ? (
          <p>删除只是从当前状态移除，源下次刷新可能重新出现；墓碑是永久拉黑，之后不会再导入该 URL。</p>
        ) : null}
      </Section>

      <Section title="线路展示与导出上限">
        <p>
          前台频道页支持每页 10 条 / 20 条 / 全部三种查看方式，默认 10 条。线路数量多时不会一次铺满页面。
        </p>
        <p>
          管理后台「订阅与导出 → 线路显示与导出上限」可以分别调整：
          「前台默认显示行数」控制频道页最多展示多少条；
          「播放器导出行数」控制每个频道写入 M3U 的线路数量；
          「同源最多线路」限制单个采集站每频道贡献数。
          都支持填 0 表示不限制。
        </p>
      </Section>

      <Section title="探测与预算">
        <p>
          完整探测会实际拉流、测速和识别分辨率；轻量测活只检查清单/前 2KB，用来先筛掉明显死链。
          采集前会对 pending/suspect 做轻量预筛，通过后才进入完整测速。
        </p>
        <p>
          分批探测分「待测 → 待复测 → 已淘汰」三个阶段。每批条数、间隔和阶段顺序都可以在后台设置里改；
          每轮预算按“本轮最多完整测速多少条”计算，不是每天总量。
        </p>
      </Section>

      <Section title="节目单（EPG）">
        <p>
          EPG 与线路发布是分开的：后台「设置 → EPG 与通知」可以开启独立定时抓取，默认每天 00:10，
          也支持多个时间。EPG 任务只更新节目单、订阅 EPG 和 guide，不重建线路目录。
        </p>
        <p>
          线路发布（默认 08:30、17:30）只更新频道目录和订阅，不会重复抓 EPG。
          播放器通过 M3U 里的 tvg-id 与 XMLTV 频道 id 对齐；4K 频道会复用基础频道的节目单。
          显示“暂无节目单”时，优先重新导入/刷新订阅。
        </p>
      </Section>

      {scope === 'public' ? (
        <Section title="多久更新一次">
          <p>
            抓源大约每周一次；探测按后台设置的批次持续进行。线路发布按固定时刻执行，
            EPG 独立每日刷新。前台看到的是最近一次发布后的版本。
          </p>
          <p>
            前台看到的「已发布频道 / 已发布线路 / 已发布可用」是已经写入订阅的版本；
            「线路池」是包含备用、重复和未入选线路的实时统计，两者数量本来就会不同。
          </p>
        </Section>
      ) : null}

      {scope === 'admin' ? (
        <>
          <Section title="任务队列（当前）">
            <p>
              抓源、分批探测、发布、EPG、孤儿清理、手动检测和新增源都会进入全局任务队列，同一时间只运行一个。
              手动/检测中心优先级最高，新增源次之，定时任务最后。
            </p>
            <p>
              概览的「计划任务」会同时显示未到期的定时任务（抓源、线路发布、分批探测、EPG、快照）；
              到点后进入真实队列。任务名称会精确到来源和阶段，例如「抓源 · 某源」「分批探测 · 待复测」，
              完成信息会显示原始条数、入库/过滤条数、可用数、测试来源明细和 EPG 新增/删除频道。
            </p>
            <p>
              每个任务都有心跳。10–15 分钟无心跳、GitHub run 找不到或已失败时，看门狗会自动失败并重试，
              最多重试 2 次；任务卡片会直接显示失败原因，例如 GitHub 401、KV 写入超限。
              KV 写入 ≥920 时队列暂停派发。
            </p>
          </Section>

          <Section title="发布、EPG 与快照">
            <p>
              线路发布默认每天 08:30、17:30；发布只更新线路目录，不抓 EPG。
              「探测后自动发布」是独立开关，默认关闭；打开后线路池更新且超过最小间隔才自动发布。
            </p>
            <p>
              EPG 在「设置 → EPG 与通知」里独立定时，默认每天 00:10，可配置多个时间。
              发布使用当天已抓好的 EPG，不会重复抓取。
            </p>
            <p>
              快照可在「运行与日志 → 快照策略」配置：发布后自动快照、独立定时快照或完全手动；
              定时支持多个时间。快照会记录到任务清单，可一键清空全部快照记录。
            </p>
            <p>
              Telegram 日报只在每日定时发布时发送，且使用独立的日报基线；
              自动发布、快照和 EPG 任务不会重复发日报。
            </p>
          </Section>

          <Section title="收藏与排序">
            <p>
              采集站收藏：权重 ×2，收藏源排在最前，线路排序更靠前。
              单条线路收藏：在线路池点星，导出和频道页会优先展示这些线路。
            </p>
            <p>
              台标优先使用采集站/线路自带的 tvg-logo，其次按频道名匹配公共台标包；都找不到时才显示首字占位。
            </p>
          </Section>

          <Section title="定时抓源与清理">
            <p>
              抓源默认每 7 天一次，也可以在新源加入时自动抓取；连续失败 5 次的源会自动删除。
              新增源支持自动识别或手动指定 M3U / TXT / JSON / HWCTC；抓取成功但解析 0 条会标记异常并累计失败。
              设置页「维护」可以手动清理孤儿线路和 D1 里旧的裸台标文件名。
            </p>
          </Section>

          <Section title="额度与任务记录">
            <p>
              任务进度和小型运行时状态已迁到 D1，KV 只保留大产物；进度上报按 50 条或 10 秒节流，
              避免一次探测写出上千次 KV。发布默认 8 个 bucket，自动快照默认关闭。
            </p>
            <p>
              额度面板由用量采集任务定期刷新，显示 KV/D1/GitHub Actions 消耗；
              任务卡片可直接看到失败原因，不必再查日志。
            </p>
          </Section>

          <Section title="Telegram 机器人">
            <p>
              配置 Bot Token 和 Chat ID 后，可以发 /status 查看概览、/tasks 查看当前任务、
              /usage 查看 KV/D1/Actions 额度。任务失败、自动重试和系统告警会主动推送。
            </p>
          </Section>

          <Section title="留存与墓碑">
            <p>
              源刷新后不再列出的线路，默认保留 30 天（仍计入池和复测），方便源临时抽风后恢复；
              墓碑 URL 永久移除且不会再被导入。
            </p>
          </Section>
        </>
      ) : null}
    </div>
  );
}
