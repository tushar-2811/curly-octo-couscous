import { describe, expect, it } from 'vitest';
import { baseEnvSchema, ConfigError, databaseEnvSchema, loadConfig } from './index';

describe('loadConfig', () => {
  it('applies defaults', () => {
    const config = loadConfig(baseEnvSchema, {});
    expect(config.NODE_ENV).toBe('development');
    expect(config.LOG_LEVEL).toBe('info');
  });

  it('lists every invalid variable without echoing values', () => {
    const schema = baseEnvSchema.extend(databaseEnvSchema.shape);
    try {
      loadConfig(schema, { LOG_LEVEL: 'loud', DATABASE_URL: 'secret-not-a-url' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const { issues, message } = error as ConfigError;
      expect(issues).toHaveLength(2);
      expect(issues.join(' ')).toContain('LOG_LEVEL');
      expect(issues.join(' ')).toContain('DATABASE_URL');
      expect(message).not.toContain('secret-not-a-url');
    }
  });
});
