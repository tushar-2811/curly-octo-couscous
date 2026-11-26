import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SecretBox } from './secrets';

describe('SecretBox', () => {
  const key = randomBytes(32).toString('base64');

  it('round-trips and never repeats ciphertext', () => {
    const box = new SecretBox(key);
    const a = box.seal('refresh-token');
    const b = box.seal('refresh-token');
    expect(a).not.toBe(b);
    expect(a).not.toContain('refresh-token');
    expect(box.open(a)).toBe('refresh-token');
  });

  it('rejects tampering and the wrong key', () => {
    const box = new SecretBox(key);
    const sealed = box.seal('secret');
    const parts = sealed.split('.');
    parts[3] = Buffer.from('other').toString('base64url');
    expect(() => box.open(parts.join('.'))).toThrow();
    expect(() => new SecretBox(randomBytes(32).toString('base64')).open(sealed)).toThrow();
  });

  it('requires a 32-byte key', () => {
    expect(() => new SecretBox('c2hvcnQ=')).toThrow(/32 bytes/);
  });
});
