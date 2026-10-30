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
          数字表示综合得分，不是线路数量。例如「信誉 16/100 · 降权」表示该采集站近期可用率/质量偏低，
          会排在更可靠的源后面，并分到更少的完整测速预算；但每个启用的源每轮仍至少有 1 条机会，避免小源永远轮不到。
        </p>
        <p>分数由每次抓取后的可用线路占比、平均线路质量、抓取是否成功共同决定；长期稳定会逐步升到正常/优质。</p>
      </Section>

      <Section title="线路状态与线路池">
        <p>
          每条线路会经历：待测（pending）→ 可用（alive）→ 可疑（suspect）→ 失效（dead）。
          连续 3 次失败才判定失效，之后到期允许复测；一次失败只会先进入可疑，避免临时抖动误杀。
        </p>
        <p>
          线路池分为：精品（premium，订阅优先导出）、备用（backup）、候选（candidate，可用但分辨率未确认）、
          待测（pending）、隔离（quarantine，近期失败）、淘汰（rejected，失效）。
          订阅只导出精品和备用；候选不会导出。
        </p>
        {scope === 'admin' ? (
          <p>删除只是从当前状态移除，源下次刷新可能重新出现；墓碑是永久拉黑，之后不会再导入该 URL。</p>
        ) : null}
      </Section>

      <Section title="探测与预算">
        <p>
          完整探测会实际拉流、测速和识别分辨率；轻量测活只检查清单/前 2KB 是否有响应，用来先筛掉明显死链。
          采集前会先对 pending/suspect 做轻量预筛，通过后才进入完整测速，节省时间和流量。
        </p>
        <p>
          预算按「本轮最多完整测速多少条」计算，不是每天总量。可用线路每通过一次复测会逐步延长间隔（最多 30 天），
          精品线路默认 7 天复测，失效线路默认 14 天后允许复活。
        </p>
      </Section>

      <Section title="分辨率与测速">
        <p>
          速率是探测时采样的稳态值，受源站和网络波动影响；分辨率优先用 ffprobe 实测，缺失时按频道名/线路名推断。
          「可用」只代表探测当时能正常拉流，不保证所有播放器/所有时段都稳定。
        </p>
      </Section>

      {scope === 'admin' ? (
        <>
          <Section title="定时采集">
            <p>
              默认关闭。开启后按北京时间每天指定时刻触发；KV 今日写入 ≥920 或已有采集在跑时会自动跳过。
              它只影响 collect，不会改变清理任务和用量快照的节奏。
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
