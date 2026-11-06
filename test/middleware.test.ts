import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import {
  accessLogMiddleware,
  ConflictError,
  DependencyUnavailableError,
  errorHandler,
  ForbiddenError,
  NotFoundError,
  notFoundHandler,
  requestContext,
  requestContextMiddleware,
  type Logger,
} from '../src/index.js';

function fakeLogger() {
  const info = vi.fn();
  const error = vi.fn();
  return { logger: { info, error } as unknown as Logger, info, error };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROBLEM = 'application/problem+json';

describe('requestContextMiddleware', () => {
  function buildApp() {
    const app = express();
    app.use(requestContextMiddleware());
    app.get('/ctx', async (req, res) => {
      await Promise.resolve(); // Ngữ cảnh phải sống qua điểm await
      res.json({ fromReq: req.requestId, fromContext: requestContext.get()?.requestId });
    });
    return app;
  }

  it('không có header → tự sinh UUID, trả lại trong header phản hồi', async () => {
    const res = await request(buildApp()).get('/ctx').expect(200);
    const id = res.headers['x-request-id'];
    expect(id).toMatch(UUID);
    expect(res.body).toEqual({ fromReq: id, fromContext: id });
  });

  it('nhận x-request-id hợp lệ từ BFF/ALB', async () => {
    const res = await request(buildApp())
      .get('/ctx')
      .set('x-request-id', 'abc-12345678')
      .expect(200);
    expect(res.headers['x-request-id']).toBe('abc-12345678');
    expect(res.body.fromContext).toBe('abc-12345678');
  });

  it.each(['short', 'has spaces in it', 'a'.repeat(65), 'bad_underscore_id'])(
    'x-request-id không hợp lệ (%s) → bị bỏ, sinh UUID mới',
    async (incoming) => {
      const res = await request(buildApp()).get('/ctx').set('x-request-id', incoming).expect(200);
      expect(res.headers['x-request-id']).toMatch(UUID);
    },
  );

  it('mỗi request có ngữ cảnh riêng, không lẫn nhau', async () => {
    const app = buildApp();
    const [a, b] = await Promise.all([
      request(app).get('/ctx').set('x-request-id', 'request-aaaaaaaa'),
      request(app).get('/ctx').set('x-request-id', 'request-bbbbbbbb'),
    ]);
    expect(a.body.fromContext).toBe('request-aaaaaaaa');
    expect(b.body.fromContext).toBe('request-bbbbbbbb');
  });

  it('ngoài request thì không có ngữ cảnh', () => {
    expect(requestContext.get()).toBeUndefined();
  });
});

describe('accessLogMiddleware', () => {
  function buildApp(logger: Logger) {
    const app = express();
    app.use(accessLogMiddleware(logger));
    app.get('/v1/tenants/:tenantId', (_req, res) => void res.json({ ok: true }));
    app.get('/health/live', (_req, res) => void res.json({ status: 'ok' }));
    app.use(notFoundHandler());
    return app;
  }

  it('ghi 1 dòng http_request với mẫu route, status và thời gian', async () => {
    const { logger, info } = fakeLogger();
    await request(buildApp(logger)).get('/v1/tenants/t-123').expect(200);

    await vi.waitFor(() => expect(info).toHaveBeenCalledTimes(1));
    expect(info).toHaveBeenCalledWith(
      {
        method: 'GET',
        route: '/v1/tenants/:tenantId',
        status: 200,
        durationMs: expect.any(Number),
      },
      'http_request',
    );
  });

  it('đường dẫn không khớp route nào → ghi path thật và status 404', async () => {
    const { logger, info } = fakeLogger();
    await request(buildApp(logger)).get('/khong-co').expect(404);

    await vi.waitFor(() => expect(info).toHaveBeenCalledTimes(1));
    expect(info.mock.calls[0]?.[0]).toMatchObject({ route: '/khong-co', status: 404 });
  });

  it('bỏ qua /health để không đầy log', async () => {
    const { logger, info } = fakeLogger();
    const app = buildApp(logger);
    await request(app).get('/health/live').expect(200);
    await request(app).get('/v1/tenants/t1').expect(200);

    await vi.waitFor(() => expect(info).toHaveBeenCalledTimes(1));
    expect(info.mock.calls[0]?.[0]).toMatchObject({ route: '/v1/tenants/:tenantId' });
  });
});

describe('notFoundHandler', () => {
  it('trả 404 dạng problem+json kèm requestId', async () => {
    const app = express();
    app.use(requestContextMiddleware());
    app.use(notFoundHandler());

    const res = await request(app).get('/khong-co').expect(404);
    expect(res.type).toBe(PROBLEM);
    expect(res.body).toEqual({
      type: 'https://errors.ol-platform.dev/not_found',
      title: 'Không tìm thấy',
      status: 404,
      code: 'not_found',
      requestId: res.headers['x-request-id'],
    });
  });
});

describe('errorHandler', () => {
  function buildApp(logger: Logger, route: express.RequestHandler, jsonLimit?: string) {
    const app = express();
    app.use(requestContextMiddleware());
    app.use(express.json(jsonLimit ? { limit: jsonLimit } : {}));
    app.all('/boom', route);
    app.use(errorHandler(logger));
    return app;
  }

  it('AppError 4xx → đúng status, problem+json, details, log ở mức info', async () => {
    const { logger, info, error } = fakeLogger();
    const app = buildApp(logger, () => {
      throw new ForbiddenError('Cấm vào', { permission: 'a.b.c' });
    });
    const res = await request(app).get('/boom').expect(403);

    expect(res.type).toBe(PROBLEM);
    expect(res.body).toEqual({
      type: 'https://errors.ol-platform.dev/forbidden',
      title: 'Cấm vào',
      status: 403,
      code: 'forbidden',
      requestId: res.headers['x-request-id'],
      details: { permission: 'a.b.c' },
    });
    expect(info).toHaveBeenCalledWith({ code: 'forbidden', status: 403 }, 'Cấm vào');
    expect(error).not.toHaveBeenCalled();
  });

  it('lỗi không có details → body không có khóa details', async () => {
    const { logger } = fakeLogger();
    const app = buildApp(logger, () => {
      throw new NotFoundError();
    });
    const res = await request(app).get('/boom').expect(404);
    expect(res.body).not.toHaveProperty('details');
  });

  it('ConflictError → 409', async () => {
    const { logger } = fakeLogger();
    const app = buildApp(logger, () => {
      throw new ConflictError('Trùng mã', { field: 'code' });
    });
    const res = await request(app).get('/boom').expect(409);
    expect(res.body).toMatchObject({ code: 'conflict', details: { field: 'code' } });
  });

  it('DependencyUnavailableError → 503, header retry-after, log ở mức error', async () => {
    const { logger, info, error } = fakeLogger();
    const app = buildApp(logger, () => {
      throw new DependencyUnavailableError('iam', 7);
    });
    const res = await request(app).get('/boom').expect(503);

    expect(res.headers['retry-after']).toBe('7');
    expect(res.body.code).toBe('dependency_unavailable');
    expect(error).toHaveBeenCalledWith(
      { code: 'dependency_unavailable', status: 503 },
      expect.stringContaining('iam'),
    );
    expect(info).not.toHaveBeenCalled();
  });

  it('lỗi async (reject) cũng được xử lý như lỗi đồng bộ', async () => {
    const { logger } = fakeLogger();
    const app = buildApp(logger, async () => {
      throw new NotFoundError('Không có kho');
    });
    const res = await request(app).get('/boom').expect(404);
    expect(res.body.title).toBe('Không có kho');
  });

  it('JSON sai cú pháp → 400 invalid_body', async () => {
    const { logger } = fakeLogger();
    const app = buildApp(logger, (_req, res) => void res.json({ ok: true }));
    const res = await request(app)
      .post('/boom')
      .set('content-type', 'application/json')
      .send('{"hỏng":')
      .expect(400);

    expect(res.type).toBe(PROBLEM);
    expect(res.body).toMatchObject({
      code: 'invalid_body',
      title: 'Body không hợp lệ',
      status: 400,
    });
  });

  it('body quá lớn → 413 invalid_body', async () => {
    const { logger } = fakeLogger();
    const app = buildApp(logger, (_req, res) => void res.json({ ok: true }), '10b');
    const res = await request(app)
      .post('/boom')
      .send({ du: 'x'.repeat(100) })
      .expect(413);
    expect(res.body).toMatchObject({ code: 'invalid_body', status: 413 });
  });

  it('lỗi không lường trước → 500 chung chung, KHÔNG lộ chi tiết, log đầy đủ', async () => {
    const { logger, error } = fakeLogger();
    const secret = new Error('mật khẩu DB là hunter2');
    const app = buildApp(logger, () => {
      throw secret;
    });
    const res = await request(app).get('/boom').expect(500);

    expect(res.type).toBe(PROBLEM);
    expect(res.body).toMatchObject({ code: 'internal_error', title: 'Lỗi hệ thống', status: 500 });
    expect(res.text).not.toContain('hunter2');
    expect(error).toHaveBeenCalledWith({ err: secret }, 'unhandled_error');
  });

  it('ném giá trị không phải Error (chuỗi) → vẫn 500', async () => {
    const { logger } = fakeLogger();
    const app = buildApp(logger, () => {
      throw 'chuỗi lạ';
    });
    await request(app).get('/boom').expect(500);
  });

  it('đã gửi header thì không gửi thêm phản hồi lỗi', () => {
    const { logger, info, error } = fakeLogger();
    const res = { headersSent: true, status: vi.fn(), setHeader: vi.fn() };
    const next = vi.fn();

    errorHandler(logger)(
      new NotFoundError(),
      {} as Request,
      res as unknown as Response,
      next as NextFunction,
    );

    expect(res.status).not.toHaveBeenCalled();
    expect(res.setHeader).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
