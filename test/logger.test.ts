import type * as Pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger, requestContext, type Principal } from '../src/index.js';

// Thay đích ghi của pino bằng mảng trong bộ nhớ, nhưng vẫn dùng pino thật để kiểm tra
// đúng hành vi che dữ liệu nhạy cảm, mixin và định dạng thời gian.
const lines = vi.hoisted(() => [] as string[]);

vi.mock('pino', async (importOriginal) => {
  const actual = await importOriginal<typeof Pino>();
  const sink = {
    write(line: string) {
      lines.push(line);
    },
  };
  const wrapped = Object.assign((options: Pino.LoggerOptions) => actual.pino(options, sink), {
    stdTimeFunctions: actual.pino.stdTimeFunctions,
  });
  return { ...actual, pino: wrapped };
});

function lastLine(): Record<string, unknown> {
  return JSON.parse(lines.at(-1) ?? '{}') as Record<string, unknown>;
}

const savedAppEnv = process.env.APP_ENV;

beforeEach(() => {
  lines.length = 0;
});

afterEach(() => {
  if (savedAppEnv === undefined) delete process.env.APP_ENV;
  else process.env.APP_ENV = savedAppEnv;
});

describe('createLogger', () => {
  it('gắn service, env và thời gian ISO 8601 vào mọi dòng log', () => {
    process.env.APP_ENV = 'staging';
    createLogger({ service: 'warehouse' }).info('xin chào');
    const line = lastLine();
    expect(line).toMatchObject({ service: 'warehouse', env: 'staging', msg: 'xin chào' });
    expect(new Date(line.time as string).toISOString()).toBe(line.time);
  });

  it('env mặc định là "local" khi không có APP_ENV', () => {
    delete process.env.APP_ENV;
    createLogger({ service: 'warehouse' }).info('x');
    expect(lastLine().env).toBe('local');
  });

  it('mức log mặc định là info: bỏ debug, giữ info', () => {
    const logger = createLogger({ service: 's' });
    logger.debug('bị bỏ');
    expect(lines).toHaveLength(0);
    logger.info('được giữ');
    expect(lines).toHaveLength(1);
  });

  it('tôn trọng tham số level', () => {
    createLogger({ service: 's', level: 'debug' }).debug('chi tiết');
    expect(lines).toHaveLength(1);

    lines.length = 0;
    const quiet = createLogger({ service: 's', level: 'warn' });
    quiet.info('bị bỏ');
    expect(lines).toHaveLength(0);
    quiet.warn('được giữ');
    expect(lines).toHaveLength(1);
  });

  it('che header và trường nhạy cảm bằng [REDACTED]', () => {
    createLogger({ service: 's' }).info(
      {
        req: { headers: { authorization: 'Bearer abc.def.ghi', cookie: 'sid=1', accept: 'json' } },
        res: { headers: { 'set-cookie': 'sid=2' } },
        user: { password: 'p1', token: 't1', accessToken: 'a1', refreshToken: 'r1' },
        client: { clientSecret: 'cs1' },
        principal: { token: 'pt1' },
      },
      'có dữ liệu nhạy cảm',
    );
    const raw = lines.at(-1) ?? '';
    for (const secret of ['abc.def.ghi', 'sid=1', 'sid=2', 'p1', 't1', 'a1', 'r1', 'cs1', 'pt1']) {
      expect(raw).not.toContain(`"${secret}"`);
    }
    const line = lastLine() as {
      req: { headers: Record<string, string> };
      user: Record<string, string>;
    };
    expect(line.req.headers.authorization).toBe('[REDACTED]');
    expect(line.req.headers.cookie).toBe('[REDACTED]');
    expect(line.req.headers.accept).toBe('json'); // Trường bình thường giữ nguyên
    expect(line.user.password).toBe('[REDACTED]');
  });

  it('ngoài request: không có requestId và principal', () => {
    createLogger({ service: 's' }).info('job nền');
    const line = lastLine();
    expect(line).not.toHaveProperty('requestId');
    expect(line).not.toHaveProperty('principal');
  });

  it('trong request: tự gắn requestId và principal.id từ ngữ cảnh', () => {
    const principal: Principal = {
      type: 'user',
      id: 'users/u1',
      subject: 'u1',
      token: 'secret-token',
      claims: {},
    };
    const logger = createLogger({ service: 's' });
    requestContext.run({ requestId: 'req-12345678', principal }, () =>
      logger.info('trong request'),
    );
    const line = lastLine();
    expect(line).toMatchObject({ requestId: 'req-12345678', principal: 'users/u1' });
    expect(lines.at(-1)).not.toContain('secret-token'); // Chỉ ghi id, không ghi token
  });

  it('request chưa xác thực: có requestId, không có principal', () => {
    const logger = createLogger({ service: 's' });
    requestContext.run({ requestId: 'req-87654321' }, () => logger.info('chưa đăng nhập'));
    const line = lastLine();
    expect(line.requestId).toBe('req-87654321');
    expect(line).not.toHaveProperty('principal');
  });
});
