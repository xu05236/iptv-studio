import { describe, expect, it } from 'vitest';
import { redact, redactError } from '../src/logger.js';

describe('redact', () => {
  it('masks full URLs including query tokens', () => {
    expect(redact('抓取失败 http://101.42.155.231/m3u/all.m3u?token=secret')).toBe('抓取失败 ***');
    expect(redact('https://nba.example.site/sub?token=abc 403')).toBe('*** 403');
  });

  it('masks bare hosts, IPs and ports', () => {
    expect(redact('siqn3046.myqnapcloud.com:18765')).toBe('***');
    expect(redact('#1 fetch failed ECONNREFUSED 113.226.30.73:6001')).toBe('#1 fetch failed ECONNREFUSED ***');
  });

  it('keeps Chinese text and plain channel names intact', () => {
    const line = '[warn] 抓取完成 央视一套（已完成 3/50）';
    expect(redact(line)).toBe(line);
  });

  it('redacts error stacks without touching the message prefix', () => {
    const text = redactError('上报运行结果失败', new Error('connect failed to http://10.1.2.3/x'));
    expect(text.startsWith('上报运行结果失败 connect failed to ***')).toBe(true);
  });
});
