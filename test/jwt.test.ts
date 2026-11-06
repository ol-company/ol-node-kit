import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { JoseTokenVerifier, UnauthenticatedError } from '../src/index.js';

const issuer = 'https://id.ol.test/realms/ol';
let privateKey: CryptoKey;
let verifier: JoseTokenVerifier;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256' };
  verifier = new JoseTokenVerifier({
    issuer,
    audience: 'ol-api',
    jwks: createLocalJWKSet({ keys: [jwk] }),
  });
});

function sign(claims: Record<string, unknown>, aud = 'ol-api') {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(issuer)
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
});
