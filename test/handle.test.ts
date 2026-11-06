import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  errorHandler,
  handle,
  NotFoundError,
  policy,
  requestContext,
  requestContextMiddleware,
  SecureRouter,
  UnauthenticatedError,
  type Authorizer,
  type Logger,
  type TokenVerifier,
} from '../src/index.js';

const verifier: TokenVerifier = {
  verify: async (token) => {
    if (token !== 'good') throw new UnauthenticatedError();
    return { type: 'user', id: 'users/u1', subject: 'u1', token, claims: {} };
  },
};

const allow: Authorizer = {
  check: vi.fn().mockResolvedValue({ allow: true, reason: 'binding', policyVersion: 1 }),
};
const silent = { info: vi.fn(), error: vi.fn() } as unknown as Logger;

function build(
  setup: (router: SecureRouter) => void,
  authorizer: Authorizer = allow,
  log?: Logger,
) {
  const router = new SecureRouter({ verifier, authorizer, logger: log });
  setup(router);
  const app = express();
  app.use(express.json());
  app.use(requestContextMiddleware());
  app.use(router.router);
  app.use(errorHandler(silent));
  return { app, router };
}

const auth = { authorization: 'Bearer good' };

describe('policy', () => {
  it('tạo đúng cấu trúc policy', () => {
    const resource = (p: Record<string, string>) => `tenants/${p.tenantId}`;
    expect(policy.public()).toEqual({ kind: 'public' });
    expect(policy.authenticated()).toEqual({ kind: 'authenticated' });
    expect(policy.permission('a.b.c', resource)).toEqual({
      kind: 'permission',
      permission: 'a.b.c',
      resource,
    });
  });
});

describe('SecureRouter – phương thức HTTP và xác thực', () => {
  const methods = ['get', 'post', 'put', 'patch', 'delete'] as const;

  it('hỗ trợ đủ get/post/put/patch/delete và ghi nhận vào definitions', async () => {
    const { app, router } = build((r) => {
      const ok = (_req: express.Request, res: express.Response) => void res.json({ ok: true });
      r.get('/things', policy.authenticated(), ok);
      r.post('/things', policy.authenticated(), ok);
      r.put('/things', policy.authenticated(), ok);
      r.patch('/things', policy.authenticated(), ok);
      r.delete('/things', policy.authenticated(), ok);
    });

    for (const method of methods) {
      await request(app)[method]('/things').set(auth).expect(200);
    }
    expect(router.definitions.map((d) => d.method)).toEqual([...methods]);
    expect(router.definitions.every((d) => d.policy.kind === 'authenticated')).toBe(true);
  });

  it('cho phép nối chuỗi các lời khai báo route', () => {
    const { router } = build((r) => {
      const chained = r
        .get('/a', policy.public(), (_req, res) => void res.end())
        .post('/b', policy.public(), (_req, res) => void res.end());
      expect(chained).toBe(r);
    });
    expect(router.definitions).toHaveLength(2);
  });

  it('policy authenticated: có token hợp lệ là qua, không hỏi IAM', async () => {
    const authorizer: Authorizer = { check: vi.fn() };
    const { app } = build(
      (r) => r.get('/me', policy.authenticated(), (_req, res) => void res.json({ ok: true })),
      authorizer,
    );
    await request(app).get('/me').set(auth).expect(200);
    expect(authorizer.check).not.toHaveBeenCalled();
  });

  it.each([
    ['không có header', undefined],
    ['sai scheme (Basic)', 'Basic dXNlcjpwYXNz'],
    ['Bearer nhưng token sai', 'Bearer bad'],
  ])('%s → 401 problem+json', async (_name, header) => {
    const { app } = build((r) =>
      r.get('/me', policy.authenticated(), (_req, res) => void res.json({ ok: true })),
    );
    const req = request(app).get('/me');
    if (header) req.set('authorization', header);
    const res = await req.expect(401);
    expect(res.type).toBe('application/problem+json');
    expect(res.body.code).toBe('unauthenticated');
  });

  it('gắn principal vào request và vào ngữ cảnh để logger tự ghi', async () => {
    const { app } = build((r) =>
      r.get('/me', policy.authenticated(), (req, res) => {
        res.json({
          fromReq: req.principal?.id,
          fromContext: requestContext.get()?.principal?.id,
        });
      }),
    );
    const res = await request(app).get('/me').set(auth).expect(200);
    expect(res.body).toEqual({ fromReq: 'users/u1', fromContext: 'users/u1' });
  });
});

describe('SecureRouter – phân quyền', () => {
  it('tên tài nguyên sai định dạng → 400, không hỏi IAM', async () => {
    const authorizer: Authorizer = { check: vi.fn() };
    const { app } = build(
      (r) =>
        r.get(
          '/x',
          policy.permission('demo.things.list', () => 'khong/hop/le'),
          (_req, res) => void res.json({ ok: true }),
        ),
      authorizer,
    );
    const res = await request(app).get('/x').set(auth).expect(400);
    expect(res.body.code).toBe('validation_failed');
    expect(authorizer.check).not.toHaveBeenCalled();
  });

  it('bị từ chối → ghi log authz_denied với permission, resource và lý do', async () => {
    const info = vi.fn();
    const deny: Authorizer = {
      check: vi.fn().mockResolvedValue({ allow: false, reason: 'mfa-required', policyVersion: 3 }),
    };
    const { app } = build(
      (r) =>
        r.get(
          '/tenants/:tenantId/items',
          policy.permission('demo.items.list', (p) => `tenants/${p.tenantId}`),
          (_req, res) => void res.json({ ok: true }),
        ),
      deny,
      { info } as unknown as Logger,
    );

    const res = await request(app).get('/tenants/t1/items').set(auth).expect(403);
    expect(res.body.details).toEqual({ reason: 'mfa-required', permission: 'demo.items.list' });
    expect(info).toHaveBeenCalledWith(
      { permission: 'demo.items.list', resource: 'tenants/t1', reason: 'mfa-required' },
      'authz_denied',
    );
  });

  it('bị từ chối mà không truyền logger vẫn trả 403', async () => {
    const deny: Authorizer = {
      check: vi.fn().mockResolvedValue({ allow: false, reason: 'no-binding', policyVersion: 1 }),
    };
    const { app } = build(
      (r) =>
        r.get(
          '/platform',
          policy.permission('demo.items.list', () => 'platform'),
          (_req, res) => void res.json({ ok: true }),
        ),
      deny,
    );
    await request(app).get('/platform').set(auth).expect(403);
  });
});

describe('handle()', () => {
  const bodySchema = z.object({ name: z.string().min(1), qty: z.number().int().min(1) });

  it('validate body, gọi use case, trả JSON với status tùy chọn', async () => {
    const { app } = build((r) =>
      r.post(
        '/items',
        policy.authenticated(),
        handle(
          { body: bodySchema },
          ({ body, principal }) => ({ ...body, createdBy: principal.id }),
          { status: 201 },
        ),
      ),
    );
    const res = await request(app).post('/items').set(auth).send({ name: 'Ốc vít', qty: 3 });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ name: 'Ốc vít', qty: 3, createdBy: 'users/u1' });
  });

  it('mặc định trả 200', async () => {
    const { app } = build((r) =>
      r.get(
        '/ping',
        policy.authenticated(),
        handle({}, () => ({ pong: true })),
      ),
    );
    await request(app).get('/ping').set(auth).expect(200, { pong: true });
  });

  it('body sai → 400 kèm danh sách field lỗi', async () => {
    const fn = vi.fn();
    const { app } = build((r) =>
      r.post('/items', policy.authenticated(), handle({ body: bodySchema }, fn)),
    );
    const res = await request(app)
      .post('/items')
      .set(auth)
      .send({ name: '', qty: 'ba' })
      .expect(400);

    expect(res.body.code).toBe('validation_failed');
    expect(res.body.title).toBe('body không hợp lệ');
    const paths = (res.body.details as Array<{ path: string; message: string }>).map((d) => d.path);
    expect(paths.sort()).toEqual(['name', 'qty']);
    expect(fn).not.toHaveBeenCalled();
  });

  it('use case trả undefined → 204 không nội dung', async () => {
    const { app } = build((r) =>
      r.delete(
        '/items/:id',
        policy.authenticated(),
        handle({}, () => undefined),
      ),
    );
    const res = await request(app).delete('/items/1').set(auth).expect(204);
    expect(res.text).toBe('');
  });

  it('validate params và dùng giá trị đã chuyển kiểu', async () => {
    const params = z.object({ id: z.string().regex(/^\d+$/).transform(Number) });
    const { app } = build((r) =>
      r.get(
        '/items/:id',
        policy.authenticated(),
        handle({ params }, ({ params: p }) => p),
      ),
    );
    await request(app).get('/items/42').set(auth).expect(200, { id: 42 });
    const bad = await request(app).get('/items/abc').set(auth).expect(400);
    expect(bad.body.title).toBe('params không hợp lệ');
  });

  it('không khai báo schema params thì lấy nguyên req.params', async () => {
    const { app } = build((r) =>
      r.get(
        '/items/:id',
        policy.authenticated(),
        handle({}, ({ params, body, query }) => ({
          params,
          body: body ?? null,
          query: query ?? null,
        })),
      ),
    );
    await request(app)
      .get('/items/7')
      .set(auth)
      .expect(200, { params: { id: '7' }, body: null, query: null });
  });

  it('validate query string với giá trị mặc định', async () => {
    const query = z.object({ page: z.coerce.number().int().min(1).default(1) });
    const { app } = build((r) =>
      r.get(
        '/items',
        policy.authenticated(),
        handle({ query }, ({ query: q }) => q),
      ),
    );
    await request(app).get('/items').set(auth).expect(200, { page: 1 });
    await request(app).get('/items?page=3').set(auth).expect(200, { page: 3 });
    const bad = await request(app).get('/items?page=0').set(auth).expect(400);
    expect(bad.body.title).toBe('query không hợp lệ');
  });

  it('use case tự gửi phản hồi thì handle() không gửi thêm', async () => {
    const { app } = build((r) =>
      r.get(
        '/custom',
        policy.authenticated(),
        handle({}, ({ res }) => {
          res.status(202).json({ queued: true });
          return 'bị bỏ qua';
        }),
      ),
    );
    await request(app).get('/custom').set(auth).expect(202, { queued: true });
  });

  it('use case ném AppError → errorHandler trả đúng status', async () => {
    const { app } = build((r) =>
      r.get(
        '/items/:id',
        policy.authenticated(),
        handle({}, async () => {
          throw new NotFoundError('Không có mặt hàng');
        }),
      ),
    );
    const res = await request(app).get('/items/1').set(auth).expect(404);
    expect(res.body.title).toBe('Không có mặt hàng');
  });

  it('dùng handle() trên route public (chưa có principal) → 401, không chạy use case', async () => {
    const fn = vi.fn();
    const { app } = build((r) => r.get('/open', policy.public(), handle({}, fn)));
    await request(app).get('/open').expect(401);
    expect(fn).not.toHaveBeenCalled();
  });
});
