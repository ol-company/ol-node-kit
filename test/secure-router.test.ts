import express from 'express';
import { pino } from 'pino';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import {
  errorHandler,
  policy,
  requestContextMiddleware,
  SecureRouter,
  UnauthenticatedError,
  type Authorizer,
  type TokenVerifier,
} from '../src/index.js';

const logger = pino({ level: 'silent' });
const verifier: TokenVerifier = {
  verify: async (t) => {
    if (t !== 'good') throw new UnauthenticatedError();
    return { type: 'user', id: 'users/u1', subject: 'u1', token: t, claims: {} };
  },
};

function buildApp(authorizer: Authorizer) {
  const r = new SecureRouter({ verifier, authorizer, logger });
  r.get('/public', policy.public(), (_req, res) => void res.json({ ok: true }));
  r.get(
    '/tenants/:tenantId/things',
    policy.permission('demo.things.list', (p) => `tenants/${p.tenantId}`),
    (_req, res) => void res.json({ ok: true }),
  );
  const app = express();
  app.use(requestContextMiddleware());
  app.use(r.router);
  app.use(errorHandler(logger));
  return { app, router: r };
}

describe('SecureRouter', () => {
  const allowAll: Authorizer = {
    check: vi.fn().mockResolvedValue({ allow: true, reason: 'binding', policyVersion: 1 }),
  };
  const denyAll: Authorizer = {
    check: vi.fn().mockResolvedValue({ allow: false, reason: 'no-binding', policyVersion: 1 }),
  };

  it('route public không cần token', async () => {
    await request(buildApp(denyAll).app).get('/public').expect(200);
  });

  it('thiếu token → 401', async () => {
    await request(buildApp(allowAll).app).get('/tenants/t1/things').expect(401);
  });

  it('IAM từ chối → 403 kèm lý do', async () => {
    const res = await request(buildApp(denyAll).app)
      .get('/tenants/t1/things')
      .set('authorization', 'Bearer good')
      .expect(403);
    expect(res.body.details.reason).toBe('no-binding');
  });

  it('IAM cho phép → 200, hỏi đúng resource', async () => {
    await request(buildApp(allowAll).app)
      .get('/tenants/t1/things')
      .set('authorization', 'Bearer good')
      .expect(200);
    expect(allowAll.check).toHaveBeenCalledWith({
      principal: 'users/u1',
      permission: 'demo.things.list',
      resource: 'tenants/t1',
    });
  });

  it('tham số chứa "/" mã hóa → 400, không bao giờ tới IAM', async () => {
    const authz: Authorizer = { check: vi.fn() };
    await request(buildApp(authz).app)
      .get('/tenants/t1%2F..%2Ft2/things')
      .set('authorization', 'Bearer good')
      .expect(400);
    expect(authz.check).not.toHaveBeenCalled();
  });

  it('mọi route đều có policy được khai báo', () => {
    const { router } = buildApp(allowAll);
    expect(router.definitions.every((d) => d.policy !== undefined)).toBe(true);
  });
});
