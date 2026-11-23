import { describe, expect, it } from 'vitest';
import { stableStringify } from './index';

describe('stableStringify', () => {
  it('orders keys so equal content hashes the same', () => {
    expect(stableStringify({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } })).toBe(
      stableStringify({ a: { c: null, d: [2, { y: 2, z: 1 }] }, b: 1 }),
    );
  });

  it('drops undefined values', () => {
    expect(stableStringify({ a: undefined, b: 1 })).toBe('{"b":1}');
  });
});
