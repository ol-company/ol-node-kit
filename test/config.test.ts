import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { envBoolean, loadConfig } from '../src/index.js';

const schema = z.object({
  PORT: z.coerce.number().int().positive(),
  DATABASE_URL: z.string().min(1),
  APP_ENV: z.enum(['local', 'staging', 'production']).default('local'),
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('loadConfig', () => {
  it('trả về config đã parse và áp giá trị mặc định', () => {
    const config = loadConfig(schema, { PORT: '3000', DATABASE_URL: 'postgres://db/app' });
    expect(config).toEqual({ PORT: 3000, DATABASE_URL: 'postgres://db/app', APP_ENV: 'local' });
  });

  it('mặc định đọc từ process.env', () => {
    vi.stubEnv('PORT', '8080');
    vi.stubEnv('DATABASE_URL', 'postgres://db/app');
    vi.stubEnv('APP_ENV', 'staging');
    expect(loadConfig(schema)).toEqual({
      PORT: 8080,
      DATABASE_URL: 'postgres://db/app',
      APP_ENV: 'staging',
    });
  });

  it('thiếu hoặc sai biến → ném lỗi liệt kê đúng tên từng biến', () => {
    expect(() => loadConfig(schema, { PORT: 'abc', APP_ENV: 'prod' })).toThrow(
      /Cấu hình không hợp lệ:[\s\S]*- PORT:[\s\S]*- DATABASE_URL:[\s\S]*- APP_ENV:/,
    );
  });

  it('KHÔNG đưa giá trị biến (có thể là bí mật) vào thông báo lỗi', () => {
    const strict = z.object({ API_SECRET: z.string().min(20) });
    let message = '';
    try {
      loadConfig(strict, { API_SECRET: 'hunter2' });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('API_SECRET');
    expect(message).not.toContain('hunter2');
  });

  it('lỗi ở mức gốc của schema được ghi là (root)', () => {
    const rootRule = z.object({}).refine(() => false, 'luôn sai');
    expect(() => loadConfig(rootRule, {})).toThrow('- (root): luôn sai');
  });
});

describe('envBoolean', () => {
  it.each(['true', '1', 'yes', 'on', 'TRUE', 'Yes', 'ON'])('"%s" → true', (value) => {
    expect(envBoolean(value)).toBe(true);
  });

  it.each(['false', '0', 'no', 'off', 'abc'])('"%s" → false', (value) => {
    expect(envBoolean(value)).toBe(false);
  });

  it('thiếu hoặc rỗng → dùng giá trị fallback', () => {
    expect(envBoolean(undefined)).toBe(false);
    expect(envBoolean('')).toBe(false);
    expect(envBoolean(undefined, true)).toBe(true);
    expect(envBoolean('', true)).toBe(true);
  });

  it('có giá trị thì bỏ qua fallback', () => {
    expect(envBoolean('false', true)).toBe(false);
    expect(envBoolean('true', false)).toBe(true);
  });
});
