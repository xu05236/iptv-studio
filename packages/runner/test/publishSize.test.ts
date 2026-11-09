import { describe, expect, it } from 'vitest';
import { ARTIFACT_BLOCK_BYTES, ARTIFACT_WARN_BYTES, artifactSizeLevel } from '../src/pipeline/publish.js';

describe('artifact size guard', () => {
  it('passes normal artifacts', () => {
    expect(artifactSizeLevel(9 * 1024 * 1024)).toBe('ok');
    expect(artifactSizeLevel(ARTIFACT_WARN_BYTES)).toBe('ok');
  });

  it('warns between 15MB and 22MB', () => {
    expect(artifactSizeLevel(ARTIFACT_WARN_BYTES + 1)).toBe('warn');
    expect(artifactSizeLevel(ARTIFACT_BLOCK_BYTES)).toBe('warn');
  });

  it('blocks above 22MB', () => {
    expect(artifactSizeLevel(ARTIFACT_BLOCK_BYTES + 1)).toBe('block');
    expect(artifactSizeLevel(25 * 1024 * 1024)).toBe('block');
  });
});
