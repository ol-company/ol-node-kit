import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CachingAuthorizer,
  DependencyUnavailableError,
  HttpAuthorizer,
  type Authorizer,
  type AuthzDecision,
  type Logger,
} from '../src/index.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const input = {
  principal: 'users/u1',
  permission: 'warehouse.items.list',
  resource: 'tenants/t1/warehouses/w1',
};
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

  it('allow còn hạn thì dùng cache, hết hạn (30 giây) thì hỏi lại IAM', async () => {
    vi.useFakeTimers();
    const inner: Authorizer = { check: vi.fn().mockResolvedValue(allow) };
    const authz = new CachingAuthorizer(inner);

    await authz.check(input);
    vi.advanceTimersByTime(29_000);
    await authz.check(input);
    expect(inner.check).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2_000);
    await authz.check(input);
    expect(inner.check).toHaveBeenCalledTimes(2);
  });

  it('cache theo từng bộ (principal, permission, resource)', async () => {
    const inner: Authorizer = { check: vi.fn().mockResolvedValue(allow) };
    const authz = new CachingAuthorizer(inner);

    await authz.check(input);
    await authz.check({ ...input, principal: 'users/u2' });
    await authz.check({ ...input, permission: 'warehouse.items.delete' });
    await authz.check({ ...input, resource: 'tenants/t2/warehouses/w1' });
    expect(inner.check).toHaveBeenCalledTimes(4);
  });

  it('cache hết hạn mà IAM lỗi → fail closed, không dùng lại quyết định cũ', async () => {
    vi.useFakeTimers();
    const check = vi.fn().mockResolvedValueOnce(allow).mockRejectedValueOnce(new Error('down'));
    const authz = new CachingAuthorizer({ check });

    await expect(authz.check(input)).resolves.toEqual(allow);
    vi.advanceTimersByTime(31_000);
    await expect(authz.check(input)).rejects.toBeInstanceOf(DependencyUnavailableError);
  });

  it('giữ nguyên DependencyUnavailableError gốc, không bọc lại', async () => {
    const original = new DependencyUnavailableError('keycloak-token', 9);
    const authz = new CachingAuthorizer({ check: vi.fn().mockRejectedValue(original) });
    await expect(authz.check(input)).rejects.toBe(original);
  });

  it('lỗi khác được bọc thành 503 và ghi log cảnh báo', async () => {
    const warn = vi.fn();
    const cause = new Error('socket hang up');
    const authz = new CachingAuthorizer(
      { check: vi.fn().mockRejectedValue(cause) },
      { logger: { warn } as unknown as Logger },
    );

    const err = await authz.check(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DependencyUnavailableError);
    expect(warn).toHaveBeenCalledWith(
      { err: cause, key: 'users/u1|warehouse.items.list|tenants/t1/warehouses/w1' },
      expect.stringContaining('fail closed'),
    );
  });

  it('đầy maxEntries thì loại phần tử cũ nhất', async () => {
    const inner: Authorizer = { check: vi.fn().mockResolvedValue(allow) };
    const authz = new CachingAuthorizer(inner, { maxEntries: 2 });
    const res = (n: number) => ({ ...input, resource: `tenants/t${n}` });

    await authz.check(res(1));
    await authz.check(res(2));
    await authz.check(res(3)); // Đầy → loại t1
    expect(inner.check).toHaveBeenCalledTimes(3);

    await authz.check(res(2)); // Còn trong cache
    await authz.check(res(3)); // Còn trong cache
    expect(inner.check).toHaveBeenCalledTimes(3);

    await authz.check(res(1)); // Đã bị loại → hỏi lại IAM
    expect(inner.check).toHaveBeenCalledTimes(4);
  });

  it('clear() xóa toàn bộ cache', async () => {
    const inner: Authorizer = { check: vi.fn().mockResolvedValue(allow) };
    const authz = new CachingAuthorizer(inner);

    await authz.check(input);
    authz.clear();
    await authz.check(input);
    expect(inner.check).toHaveBeenCalledTimes(2);
  });
});

describe('HttpAuthorizer', () => {
  const tokenProvider = { getToken: vi.fn().mockResolvedValue('svc-token') };

  it('gửi đúng hợp đồng và đọc phản hồi', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(allow), { status: 200 }));
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
    // Trả Response mới mỗi lần gọi: body chỉ đọc được một lần, mà HttpAuthorizer retry lần 2
    const fetchImpl = vi
      .fn()
      .mockImplementation(
        async () => new Response(JSON.stringify({ allow: 'yes' }), { status: 200 }),
      );
    const authz = new HttpAuthorizer({ baseUrl: 'http://iam', tokenProvider, fetchImpl });
    await expect(authz.check(input)).rejects.toBeInstanceOf(DependencyUnavailableError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('gửi POST JSON đúng nội dung và có timeout', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(allow), { status: 200 }));
    const authz = new HttpAuthorizer({ baseUrl: 'http://iam', tokenProvider, fetchImpl });
    await authz.check(input);

    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'content-type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual(input);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('lần đầu lỗi, lần retry thành công → trả quyết định', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(deny), { status: 200 }));
    const authz = new HttpAuthorizer({ baseUrl: 'http://iam', tokenProvider, fetchImpl });

    await expect(authz.check(input)).resolves.toEqual(deny);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('lỗi mạng (fetch reject, kể cả timeout) → thử lại rồi báo 503', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const authz = new HttpAuthorizer({ baseUrl: 'http://iam', tokenProvider, fetchImpl });

    const err = await authz.check(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DependencyUnavailableError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('IAM trả HTTP lỗi → 503 kèm mã HTTP trong thông báo', async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(async () => new Response('unavailable', { status: 502 }));
    const authz = new HttpAuthorizer({ baseUrl: 'http://iam', tokenProvider, fetchImpl });
    await expect(authz.check(input)).rejects.toThrow(/HTTP 502/);
  });

  it('input sai hợp đồng thì không bao giờ gọi IAM', async () => {
    const fetchImpl = vi.fn();
    const authz = new HttpAuthorizer({ baseUrl: 'http://iam', tokenProvider, fetchImpl });

    await expect(authz.check({ ...input, principal: 'ai-do' })).rejects.toThrow();
    await expect(authz.check({ ...input, resource: 'khong-hop-le' })).rejects.toThrow();
    await expect(authz.check({ ...input, permission: 'khong hop le' })).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('không truyền fetchImpl → dùng fetch toàn cục', async () => {
    const globalFetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(allow), { status: 200 }));
    vi.stubGlobal('fetch', globalFetch);
    const authz = new HttpAuthorizer({ baseUrl: 'http://iam', tokenProvider });

    await expect(authz.check(input)).resolves.toEqual(allow);
    expect(globalFetch).toHaveBeenCalledTimes(1);
  });
});
