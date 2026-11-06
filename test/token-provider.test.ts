import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClientCredentialsTokenProvider, DependencyUnavailableError } from '../src/index.js';

const endpoint = 'http://keycloak/realms/ol/protocol/openid-connect/token';

const tokenResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

function provider(fetchImpl?: typeof fetch) {
  return new ClientCredentialsTokenProvider({
    tokenEndpoint: endpoint,
    clientId: 'ol-warehouse',
    clientSecret: 's3cr:et/ü',
    fetchImpl,
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ClientCredentialsTokenProvider', () => {
  it('gửi client_credentials với HTTP Basic đã mã hóa URL (RFC 6749 §2.3.1)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(tokenResponse({ access_token: 'tok-1' }));
    await expect(provider(fetchImpl).getToken()).resolves.toBe('tok-1');

    const [url, init] = fetchImpl.mock.calls[0]!;
    const request = init as RequestInit;
    const headers = request.headers as Record<string, string>;
    const basic = Buffer.from(`ol-warehouse:${encodeURIComponent('s3cr:et/ü')}`).toString('base64');
    expect(url).toBe(endpoint);
    expect(request.method).toBe('POST');
    expect(headers.authorization).toBe(`Basic ${basic}`);
    expect(headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(String(request.body)).toBe('grant_type=client_credentials');
    expect(request.signal).toBeInstanceOf(AbortSignal); // Có timeout
  });

  it('cache token, lần gọi sau không gọi lại Keycloak', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(tokenResponse({ access_token: 'tok-1' }));
    const p = provider(fetchImpl);
    await p.getToken();
    await expect(p.getToken()).resolves.toBe('tok-1');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('lấy token mới khi còn dưới 30 giây là hết hạn', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse({ access_token: 'tok-1', expires_in: 300 }))
      .mockResolvedValueOnce(tokenResponse({ access_token: 'tok-2', expires_in: 300 }));
    const p = provider(fetchImpl);

    await expect(p.getToken()).resolves.toBe('tok-1');
    vi.setSystemTime(start + 269_000); // Còn 31 giây → dùng lại
    await expect(p.getToken()).resolves.toBe('tok-1');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    vi.setSystemTime(start + 271_000); // Còn 29 giây → làm mới
    await expect(p.getToken()).resolves.toBe('tok-2');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('thiếu expires_in → coi như sống 60 giây', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse({ access_token: 'tok-1' }))
      .mockResolvedValueOnce(tokenResponse({ access_token: 'tok-2' }));
    const p = provider(fetchImpl);

    await p.getToken();
    vi.setSystemTime(start + 29_000);
    await expect(p.getToken()).resolves.toBe('tok-1');
    vi.setSystemTime(start + 31_000);
    await expect(p.getToken()).resolves.toBe('tok-2');
  });

  it('single-flight: nhiều lời gọi đồng thời chỉ gọi Keycloak một lần', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(tokenResponse({ access_token: 'tok-1' }));
    const p = provider(fetchImpl);
    const tokens = await Promise.all([p.getToken(), p.getToken(), p.getToken()]);
    expect(tokens).toEqual(['tok-1', 'tok-1', 'tok-1']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('lỗi mạng → 503, và lần gọi sau thử lại được (không kẹt ở lỗi cũ)', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(tokenResponse({ access_token: 'tok-1' }));
    const p = provider(fetchImpl);

    await expect(p.getToken()).rejects.toBeInstanceOf(DependencyUnavailableError);
    await expect(p.getToken()).resolves.toBe('tok-1');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('Keycloak trả HTTP lỗi → 503 kèm mã HTTP', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('no', { status: 401 }));
    const err = await provider(fetchImpl)
      .getToken()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DependencyUnavailableError);
    expect(err).toMatchObject({ status: 503, code: 'dependency_unavailable' });
    expect((err as Error).message).toContain('HTTP 401');
  });

  it('phản hồi không có access_token → 503', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(tokenResponse({ token_type: 'Bearer' }));
    const err = await provider(fetchImpl)
      .getToken()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DependencyUnavailableError);
    expect((err as Error).message).toContain('không có access_token');
  });

  it('không truyền fetchImpl → dùng fetch toàn cục', async () => {
    const globalFetch = vi.fn().mockResolvedValue(tokenResponse({ access_token: 'tok-global' }));
    vi.stubGlobal('fetch', globalFetch);
    await expect(provider().getToken()).resolves.toBe('tok-global');
    expect(globalFetch).toHaveBeenCalledTimes(1);
  });
});
