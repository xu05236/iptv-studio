import type { ChannelConfig, LineEntry, Rule, RuleActions, RuleMatch } from '../types.js';
import { qualityRank } from './merge.js';

export interface RuleContext {
  channel: Pick<ChannelConfig, 'id' | 'name' | 'group' | 'tvgId'>;
  line: Pick<LineEntry, 'name' | 'url' | 'protocol' | 'resolution' | 'speedKbps' | 'sourceId' | 'tags' | 'status'>;
}

export interface CompiledRule {
  rule: Rule;
  matches: (context: RuleContext) => boolean;
}

/**
 * Rules are intentionally a small declarative DSL (not a script engine): they are
 * evaluated by the runner and by the worker preview endpoint, so they must stay
 * side-effect free and cheap.
 */
export function compileRule(rule: Rule): CompiledRule | null {
  if (!rule.enabled) return null;
  const match = rule.match ?? {};
  const channelRe = safeRegex(match.channelPattern);
  const nameRe = safeRegex(match.namePattern);
  const minRank = match.minResolution ? qualityRank(match.minResolution) : -1;
  const groups = match.groups?.map((group) => group.trim()).filter(Boolean) ?? [];
  const protocols = match.protocols ?? [];
  const sourceIds = match.sourceIds ?? [];
  const tags = match.tags ?? [];

  return {
    rule,
    matches: (context) => {
      const channel = context.channel;
      const line = context.line;
      if (groups.length && !groups.includes(channel.group)) return false;
      if (channelRe && !channelRe.test(channel.name)) return false;
      if (nameRe && !nameRe.test(line.name)) return false;
      if (protocols.length && !protocols.includes(line.protocol)) return false;
      if (minRank >= 0 && qualityRank(line.resolution ?? 'unknown') < minRank) return false;
      if (match.minSpeedKbps && (line.speedKbps ?? 0) < match.minSpeedKbps) return false;
      if (sourceIds.length && !sourceIds.includes(line.sourceId)) return false;
      if (tags.length && !tags.every((tag) => (line.tags ?? []).includes(tag))) return false;
      return true;
    },
  };
}

export function compileRules(rules: Rule[]): CompiledRule[] {
  return rules
    .slice()
    .sort((a, b) => a.priority - b.priority)
    .map(compileRule)
    .filter((compiled): compiled is CompiledRule => compiled !== null);
}

export interface RuleApplication {
  channel: ChannelConfig;
  lines: LineEntry[];
  appliedRules: string[];
}

/** Apply every matching rule; lines can be excluded, re-tagged or renamed. */
export function applyRules(channel: ChannelConfig, lines: LineEntry[], rules: CompiledRule[]): RuleApplication {
  let nextChannel: ChannelConfig = { ...channel };
  const applied = new Set<string>();
  const kept: LineEntry[] = [];

  for (const line of lines) {
    let nextLine: LineEntry = { ...line, tags: [...(line.tags ?? [])] };
    let excluded = false;

    for (const compiled of rules) {
      if (!compiled.matches({ channel: nextChannel, line: nextLine })) continue;
      applied.add(compiled.rule.id);
      const actions = compiled.rule.actions ?? {};
      if (actions.exclude) {
        excluded = true;
        break;
      }
      nextChannel = applyChannelActions(nextChannel, actions);
      if (actions.addTags?.length) {
        nextLine.tags = [...new Set([...(nextLine.tags ?? []), ...actions.addTags])];
      }
    }

    if (!excluded) kept.push(nextLine);
  }

  return { channel: nextChannel, lines: kept, appliedRules: [...applied] };
}

function applyChannelActions(channel: ChannelConfig, actions: RuleActions): ChannelConfig {
  const next = { ...channel };
  if (actions.setGroup) next.group = actions.setGroup;
  if (actions.rename) next.name = actions.rename;
  if (actions.setLogo) next.logo = actions.setLogo;
  return next;
}

function safeRegex(pattern?: string): RegExp | null {
  if (!pattern) return null;
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return null;
  }
}

export type { RuleMatch };
