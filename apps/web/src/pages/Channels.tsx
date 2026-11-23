import { useEffect, useRef, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Search, Signal, Tv, LayoutGrid, List, ChevronRight } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../lib/api';
import type { ChannelsResponse } from '../lib/types';
import { formatResolution, formatSpeed } from '../lib/format';
import { Badge, Button, Card, EmptyState, Pagination, Sheet, Skeleton } from '../components/ui';
import { ChannelLogo } from '../components/ChannelLogo';

const DEFAULT_PAGE_SIZE = 12;

export function Channels() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const group = params.get('group') ?? '';
  const sort = params.get('sort') === 'name' ? 'name' : 'availability';
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1);
  const pageSize = Math.min(50, Math.max(10, Number(params.get('size') ?? String(DEFAULT_PAGE_SIZE)) || DEFAULT_PAGE_SIZE));
  const [search, setSearch] = useState(params.get('q') ?? '');
  const [debounced, setDebounced] = useState(search);
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [groupOpen, setGroupOpen] = useState(false);
  const [groupQuery, setGroupQuery] = useState('');
  const catScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), 280);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    const next = new URLSearchParams(params);
    if (debounced) next.set('q', debounced);
    else next.delete('q');
    next.delete('page');
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const query = useQuery({
    queryKey: ['channels', debounced, group, sort, page, pageSize],
    queryFn: () => {
      const searchParams = new URLSearchParams({ page: String(page), limit: String(pageSize), sort });
      if (debounced) searchParams.set('q', debounced);
      if (group) searchParams.set('group', group);
      return api.get<ChannelsResponse>(`/api/public/channels?${searchParams.toString()}`);
    },
    placeholderData: keepPreviousData,
  });

  const items = query.data?.items ?? [];
  const groups = query.data?.groups ?? [];
  const total = query.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  useEffect(() => {
    if (!group) return;
    const node = catScrollRef.current?.querySelector<HTMLElement>(`[data-group="${CSS.escape(group)}"]`);
    node?.scrollIntoView({ inline: 'center', block: 'nearest' });
  }, [group, groups.length]);

  useEffect(() => {
    if (query.data && page > totalPages) {
      const next = new URLSearchParams(params);
      next.delete('page');
      setParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.data, page, totalPages]);

  return (
    <div className="stack" style={{ marginTop: 6 }}>
      <div className="portal-channels__hero">
        <div>
          <h1 className="large-title">频道</h1>
          <p className="subhead" style={{ marginTop: 4 }}>
            {query.data ? `${total} 个频道 · ${groups.length} 个分类` : '正在读取频道索引'}
          </p>
        </div>
      </div>

      <div className="portal-filter">
        <div className="search">
          <Search size={16} className="search__icon" />
          <input
            className="input"
            placeholder="搜索频道、CCTV、卫视…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            autoComplete="off"
          />
        </div>

        <div className="portal-filter__bar">
          <div className="portal-filter__row portal-filter__row--cats">
          <span className="portal-filter__label">分类</span>
          <div className="portal-filter__cats">
            <div className="portal-cats__scroll" ref={catScrollRef}>
              <button className={clsx('chip', !group && 'chip--active')} onClick={() => updateGroup('')}>
                全部<span className="chip__count">{groups.length}</span>
              </button>
              {groups.map((item) => (
                <button
                  key={item.group}
                  data-group={item.group}
                  className={clsx('chip', group === item.group && 'chip--active')}
                  onClick={() => updateGroup(item.group)}
                >
                  {item.group}
                  <span className="chip__count">{item.channels}</span>
                </button>
              ))}
            </div>
            <button className="portal-cats__more" onClick={() => { setGroupQuery(''); setGroupOpen(true); }}>
              更多分类
            </button>
          </div>
        </div>

        <div className="portal-filter__row">
          <span className="portal-filter__label">排序</span>
          <div className="portal-filter__chips">
            <button className={clsx('chip', sort === 'availability' && 'chip--active')} onClick={() => updateSort('availability')}>
              可用优先
            </button>
            <button className={clsx('chip', sort === 'name' && 'chip--active')} onClick={() => updateSort('name')}>
              名称排序
            </button>
          </div>
          <div className="portal-view-toggle">
            <button className={view === 'grid' ? 'is-active' : ''} onClick={() => setView('grid')}><LayoutGrid size={15} /> 网格</button>
            <button className={view === 'list' ? 'is-active' : ''} onClick={() => setView('list')}><List size={15} /> 列表</button>
          </div>
        </div>
        </div>
      </div>

      {query.isError ? (
        <Card>
          <div className="caption" style={{ color: 'var(--red, #e5484d)', marginBottom: 8 }}>
            {query.error instanceof Error ? query.error.message : '加载失败，请重试'}
          </div>
          <Button onClick={() => void query.refetch()}>重新加载</Button>
        </Card>
      ) : query.isLoading ? (
        <div className="stack stack--tight">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} height={66} radius={16} />
          ))}
        </div>
      ) : items.length ? (
        <div className={`portal-channel-grid${view === 'list' ? ' portal-channel-grid--list' : ''}`}>
          {items.map((channel) => (
            <button key={channel.id} className="portal-channel-card" onClick={() => navigate(`/channels/${encodeURIComponent(channel.id)}`)}>
              <div className="portal-channel-card__top">
                <ChannelLogo src={channel.logo} name={channel.name} tvgId={channel.tvgId} />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="portal-channel-card__name truncate">{channel.name}</div>
                  <div className="caption">{channel.group}</div>
                </div>
                {channel.bestResolution ? <Badge tone="blue">{formatResolution(channel.bestResolution)}</Badge> : null}
              </div>
              <div className="portal-channel-card__metrics">
                <span className={channel.alive > 0 ? 'is-alive' : 'is-off'}><Signal size={13} /> {channel.alive} 可用</span>
                <span>{channel.lines} 线路</span>
                {channel.bestSpeedKbps ? <span>{formatSpeed(channel.bestSpeedKbps)}</span> : null}
              </div>
              <div className="portal-channel-card__bar">
                <span style={{ width: `${channel.lines > 0 ? Math.max(3, (channel.alive / channel.lines) * 100) : 0}%` }} />
              </div>
              <div className="portal-channel-card__foot">
                <span>进入频道</span>
                <ChevronRight size={15} />
              </div>
            </button>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<Tv size={24} />}
          title={query.data?.ready === false ? '尚未生成频道数据' : '没有找到频道'}
          description={query.data?.ready === false ? '请先在管理后台触发一次采集任务。' : '换个关键词或分类试试。'}
          action={
            query.data?.ready === false ? (
              <Button variant="primary" onClick={() => navigate('/admin')}>
                去管理后台
              </Button>
            ) : undefined
          }
        />
      )}

      <div className="row row--between row--wrap">
        <span className="caption">共 {total} 个频道</span>
        <label className="row" style={{ gap: 6 }}>
          <span className="caption">每页</span>
          <select className="input" style={{ width: 88 }} value={pageSize} onChange={(event) => updatePageSize(Number(event.target.value))}>
            <option value={12}>12</option>
            <option value={24}>24</option>
            <option value={36}>36</option>
            <option value={48}>48</option>
          </select>
        </label>
      </div>

      <Pagination page={page} totalPages={totalPages} onChange={updatePage} />

      <Sheet open={groupOpen} onClose={() => setGroupOpen(false)} title="选择分类" subtitle={`共 ${groups.length} 个分类`}>
        <div className="stack" style={{ gap: 10 }}>
          <input
            className="input"
            placeholder="搜索分类"
            value={groupQuery}
            onChange={(event) => setGroupQuery(event.target.value)}
            autoFocus
          />
          <div className="portal-group-picker">
            <button className={clsx('chip', !group && 'chip--active')} onClick={() => { setGroupOpen(false); updateGroup(''); }}>
              全部<span className="chip__count">{groups.length}</span>
            </button>
            {groups
              .filter((item) => !groupQuery.trim() || item.group.toLowerCase().includes(groupQuery.trim().toLowerCase()))
              .map((item) => (
                <button
                  key={item.group}
                  className={clsx('chip', group === item.group && 'chip--active')}
                  onClick={() => { setGroupOpen(false); updateGroup(item.group); }}
                >
                  {item.group}
                  <span className="chip__count">{item.channels}</span>
                </button>
              ))}
          </div>
        </div>
      </Sheet>
    </div>
  );

  function updatePage(next: number): void {
    const nextParams = new URLSearchParams(params);
    if (next > 1) nextParams.set('page', String(next));
    else nextParams.delete('page');
    setParams(nextParams);
  }

  function updatePageSize(next: number): void {
    const nextParams = new URLSearchParams(params);
    if (next === DEFAULT_PAGE_SIZE) nextParams.delete('size');
    else nextParams.set('size', String(next));
    nextParams.delete('page');
    setParams(nextParams);
  }

  function updateGroup(next: string): void {
    const paramsNext = new URLSearchParams(params);
    if (next) paramsNext.set('group', next);
    else paramsNext.delete('group');
    paramsNext.delete('page');
    setParams(paramsNext, { replace: true });
  }

  function updateSort(next: 'availability' | 'name'): void {
    const paramsNext = new URLSearchParams(params);
    if (next === 'name') paramsNext.set('sort', 'name');
    else paramsNext.delete('sort');
    paramsNext.delete('page');
    setParams(paramsNext, { replace: true });
  }
}
