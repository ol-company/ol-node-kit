import { describe, expect, it, vi } from 'vitest';
import {
  CachingAuthorizer,
  DependencyUnavailableError,
  HttpAuthorizer,
  type Authorizer,
  type AuthzDecision,
} from '../src/index.js';

const input = { principal: 'users/u1', permission: 'warehouse.items.list', resource: 'tenants/t1/warehouses/w1' };
const allow: AuthzDecision = { allow: true, reason: 'binding', policyVersion: 1 };
const deny: AuthzDecision = { allow: false, reason: 'no-binding', policyVersion: 1 };

describe('CachingAuthorizer', () => {
  it('cache quyết định allow, không gọi IAM lần hai', async () => {
    const inner: Authorizer = { check: vi.fn().mockResolvedValue(allow) };
    const authz = new CachingAuthorizer(inner);
    await authz.check(input);
    await authz.check(input);
    expect(inner.check).toHaveBeenCalledTimes(1);
  });

  it('deny hết hạn nhanh hơn allow', async () => {
    vi.useFakeTimers();
    const inner: Authorizer = { check: vi.fn().mockResolvedValue(deny) };
    const authz = new CachingAuthorizer(inner, { denyTtlMs: 5_000, allowTtlMs: 30_000 });
    await authz.check(input);
    vi.advanceTimersByTime(6_000);
    await authz.check(input);
    expect(inner.check).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('fail closed: IAM lỗi và không có cache → ném 503, không cho qua', async () => {
    const inner: Authorizer = { check: vi.fn().mockRejectedValue(new Error('down')) };
    const authz = new CachingAuthorizer(inner);
    await expect(authz.check(input)).rejects.toBeInstanceOf(DependencyUnavailableError);
  });
});

describe('HttpAuthorizer', () => {
  const tokenProvider = { getToken: vi.fn().mockResolvedValue('svc-token') };

  it('gửi đúng hợp đồng và đọc phản hồi', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify(allow), { status: 200 }));
    const authz = new HttpAuthorizer({ baseUrl: 'http://iam', tokenProvider, fetchImpl });
    await expect(authz.check(input)).resolves.toEqual(allow);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://iam/internal/v1/authorize');
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer svc-token' });
  });

  it('retry đúng 1 lần rồi báo 503', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }));
    const authz = new HttpAuthorizer({ baseUrl: 'http://iam', tokenProvider, fetchImpl });
    await expect(authz.check(input)).rejects.toBeInstanceOf(DependencyUnavailableError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('từ chối phản hồi sai hợp đồng', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ allow: 'yes' }), { status: 200 }));
    const authz = new HttpAuthorizer({ baseUrl: 'http://iam', tokenProvider, fetchImpl });
    await expect(authz.check(input)).rejects.toBeInstanceOf(DependencyUnavailableError);
  });
});
