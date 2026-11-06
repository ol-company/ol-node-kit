import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createLocalJWKSet,
  errors as joseErrors,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JWK,
} from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DependencyUnavailableError,
  JoseTokenVerifier,
  toPrincipal,
  UnauthenticatedError,
} from '../src/index.js';

const issuer = 'https://id.ol.test/realms/ol';
let privateKey: CryptoKey;
let publicJwk: JWK;
let verifier: JoseTokenVerifier;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256' };
  verifier = new JoseTokenVerifier({
    issuer,
    audience: 'ol-api',
    jwks: createLocalJWKSet({ keys: [publicJwk] }),
  });
});

function sign(claims: Record<string, unknown>, aud = 'ol-api', iss = issuer) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(iss)
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

describe('JoseTokenVerifier', () => {
  it('token người dùng → principal users/<sub>', async () => {
    const token = await sign({ sub: 'u-1', email: 'A@Acme.test', email_verified: true });
    const p = await verifier.verify(token);
    expect(p).toMatchObject({
      type: 'user',
      id: 'users/u-1',
      email: 'a@acme.test',
      emailVerified: true,
    });
  });

  it('token service account → principal services/<clientId>', async () => {
    const token = await sign({
      sub: 's-1',
      preferred_username: 'service-account-ol-warehouse-service',
      azp: 'ol-warehouse-service',
    });
    const p = await verifier.verify(token);
    expect(p).toMatchObject({ type: 'service', id: 'services/ol-warehouse-service' });
  });

  it('sai audience → 401', async () => {
    const token = await sign({ sub: 'u-1' }, 'other-api');
    await expect(verifier.verify(token)).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('token bị sửa → 401', async () => {
    const token = await sign({ sub: 'u-1' });
    const [h, , s] = token.split('.');
    const forged = `${h}.${Buffer.from(JSON.stringify({ sub: 'admin', iss: issuer, aud: 'ol-api' })).toString('base64url')}.${s}`;
    await expect(verifier.verify(forged)).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('sai issuer → 401', async () => {
    const token = await sign({ sub: 'u-1' }, 'ol-api', 'https://evil.test/realms/ol');
    await expect(verifier.verify(token)).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('token hết hạn → 401', async () => {
    const expired = await new SignJWT({ sub: 'u-1' })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(issuer)
      .setAudience('ol-api')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3_600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 600) // Hết hạn từ 10 phút trước
      .sign(privateKey);
    await expect(verifier.verify(expired)).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('chữ ký của khóa khác (cùng kid) → 401', async () => {
    const other = await generateKeyPair('RS256');
    const token = await new SignJWT({ sub: 'u-1' })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(issuer)
      .setAudience('ol-api')
      .setExpirationTime('5m')
      .sign(other.privateKey);
    await expect(verifier.verify(token)).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('thuật toán đối xứng HS256 bị chặn → 401', async () => {
    const token = await new SignJWT({ sub: 'u-1' })
      .setProtectedHeader({ alg: 'HS256', kid: 'k1' })
      .setIssuer(issuer)
      .setAudience('ol-api')
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode('x'.repeat(32)));
    await expect(verifier.verify(token)).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('chuỗi không phải JWT → 401', async () => {
    await expect(verifier.verify('khong-phai-jwt')).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('token hợp lệ nhưng thiếu claim sub → 401', async () => {
    const token = await sign({ email: 'a@acme.test' });
    await expect(verifier.verify(token)).rejects.toThrow('Token thiếu claim sub');
  });

  it('không tìm thấy khóa khớp kid → 401 (không phải lỗi phụ thuộc)', async () => {
    const emptyKeys = new JoseTokenVerifier({
      issuer,
      audience: 'ol-api',
      jwks: createLocalJWKSet({ keys: [] }),
    });
    const token = await sign({ sub: 'u-1' });
    await expect(emptyKeys.verify(token)).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('Keycloak không phản hồi JWKS đúng hạn → 503, không phải 401', async () => {
    const timingOut = new JoseTokenVerifier({
      issuer,
      audience: 'ol-api',
      jwks: async () => {
        throw new joseErrors.JWKSTimeout();
      },
    });
    const token = await sign({ sub: 'u-1' });
    const err = await timingOut.verify(token).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DependencyUnavailableError);
    expect(err).toMatchObject({ status: 503 });
  });

  it('nhận nhiều issuer (URL công khai và URL nội bộ)', async () => {
    const internal = 'http://keycloak:8080/realms/ol';
    const multi = new JoseTokenVerifier({
      issuer: [issuer, internal],
      audience: 'ol-api',
      jwks: createLocalJWKSet({ keys: [publicJwk] }),
    });
    await expect(multi.verify(await sign({ sub: 'u-1' }))).resolves.toMatchObject({
      id: 'users/u-1',
    });
    await expect(
      multi.verify(await sign({ sub: 'u-2' }, 'ol-api', internal)),
    ).resolves.toMatchObject({ id: 'users/u-2' });
    await expect(
      multi.verify(await sign({ sub: 'u-3' }, 'ol-api', 'https://evil.test/realms/ol')),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('giữ nguyên token gốc và claims trong principal', async () => {
    const token = await sign({ sub: 'u-1', tenant: 't1' });
    const p = await verifier.verify(token);
    expect(p.token).toBe(token);
    expect(p.claims).toMatchObject({ sub: 'u-1', tenant: 't1', iss: issuer });
  });

  it('thiếu cả jwks lẫn jwksUri → lỗi cấu hình ngay khi khởi tạo', () => {
    expect(() => new JoseTokenVerifier({ issuer, audience: 'ol-api' })).toThrow(
      'JoseTokenVerifier cần jwksUri hoặc jwks',
    );
  });
});

describe('JoseTokenVerifier – JWKS tải từ xa (jwksUri)', () => {
  let server: Server;
  let jwksUri: string;
  let hits = 0;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      hits++;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ keys: [publicJwk] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    jwksUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/certs`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('tải khóa công khai qua HTTP và cache cho các lần xác minh sau', async () => {
    const remote = new JoseTokenVerifier({ issuer, audience: 'ol-api', jwksUri });
    const first = await remote.verify(await sign({ sub: 'u-1' }));
    const second = await remote.verify(await sign({ sub: 'u-2' }));

    expect(first.id).toBe('users/u-1');
    expect(second.id).toBe('users/u-2');
    expect(hits).toBe(1); // Lần hai dùng khóa đã cache
  });

  it('vẫn từ chối token giả dù khóa tải từ xa', async () => {
    const remote = new JoseTokenVerifier({ issuer, audience: 'ol-api', jwksUri });
    const [h, , s] = (await sign({ sub: 'u-1' })).split('.');
    const forged = `${h}.${Buffer.from(JSON.stringify({ sub: 'admin', iss: issuer, aud: 'ol-api' })).toString('base64url')}.${s}`;
    await expect(remote.verify(forged)).rejects.toBeInstanceOf(UnauthenticatedError);
  });
});

describe('toPrincipal', () => {
  it('claim client_id → service, ưu tiên hơn azp', () => {
    const p = toPrincipal({ sub: 's1', client_id: 'svc-a', azp: 'svc-b' }, 't');
    expect(p).toMatchObject({ type: 'service', id: 'services/svc-a', subject: 's1', token: 't' });
  });

  it('không có client_id → dùng azp', () => {
    const p = toPrincipal(
      { sub: 's1', preferred_username: 'service-account-x', azp: 'svc-b' },
      't',
    );
    expect(p.id).toBe('services/svc-b');
  });

  it('chỉ có username service-account-<clientId> → suy ra clientId từ username', () => {
    const p = toPrincipal({ sub: 's1', preferred_username: 'service-account-svc-c' }, 't');
    expect(p).toMatchObject({ type: 'service', id: 'services/svc-c' });
  });

  it('service account không mang thông tin người dùng', () => {
    const p = toPrincipal({ sub: 's1', client_id: 'svc-a', email: 'a@acme.test' }, 't');
    expect(p.email).toBeUndefined();
    expect(p.emailVerified).toBeUndefined();
  });

  it('người dùng: chuẩn hóa email, giữ tên, email_verified phải đúng là true', () => {
    const p = toPrincipal(
      { sub: 'u1', email: 'Nguyen.A@Acme.TEST', name: 'Nguyễn A', email_verified: true },
      't',
    );
    expect(p).toMatchObject({
      type: 'user',
      id: 'users/u1',
      email: 'nguyen.a@acme.test',
      name: 'Nguyễn A',
      emailVerified: true,
    });
    expect(toPrincipal({ sub: 'u1', email_verified: 'true' }, 't').emailVerified).toBe(false);
    expect(toPrincipal({ sub: 'u1' }, 't').emailVerified).toBe(false);
  });

  it('claim email/name sai kiểu thì bị bỏ qua', () => {
    const p = toPrincipal({ sub: 'u1', email: 123, name: { first: 'A' } }, 't');
    expect(p.email).toBeUndefined();
    expect(p.name).toBeUndefined();
  });

  it('preferred_username không phải chuỗi thì không bị coi là service account', () => {
    const p = toPrincipal({ sub: 'u1', preferred_username: 42 }, 't');
    expect(p.type).toBe('user');
  });

  it('thiếu sub → UnauthenticatedError', () => {
    expect(() => toPrincipal({}, 't')).toThrow(UnauthenticatedError);
    expect(() => toPrincipal({ sub: '' }, 't')).toThrow('Token thiếu claim sub');
  });
});
