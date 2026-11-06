// Xác minh access token (JWT) do Keycloak ký và chuyển thành Principal.
// Dùng thư viện jose — không tự giải mã/kiểm tra chữ ký bằng tay.
import {
  createRemoteJWKSet,
  errors as joseErrors,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';
import type { Principal } from '../context.js';
import { DependencyUnavailableError, UnauthenticatedError } from '../errors.js';

export interface TokenVerifier {
  verify(token: string): Promise<Principal>;
}

export interface JwtVerifierOptions {
  // Phải khớp claim "iss". Có thể truyền nhiều giá trị: URL công khai (https://id.ol.test/realms/ol)
  // và URL nội bộ (http://keycloak:8080/realms/ol) — phòng trường hợp token lấy qua kênh nội bộ mang iss nội bộ
  issuer: string | string[];
  audience: string; // Phải có trong claim "aud", ví dụ ol-api
  jwksUri?: string; // URL tải khóa công khai; có thể là URL nội bộ http://keycloak:8080/...
  jwks?: JWTVerifyGetKey; // Dùng trong test: truyền bộ khóa cục bộ
}

export class JoseTokenVerifier implements TokenVerifier {
  private readonly keys: JWTVerifyGetKey;

  constructor(private readonly options: JwtVerifierOptions) {
    if (options.jwks) {
      this.keys = options.jwks;
    } else if (options.jwksUri) {
      // createRemoteJWKSet tự cache khóa và tự tải lại khi gặp "kid" lạ (xoay vòng khóa)
      this.keys = createRemoteJWKSet(new URL(options.jwksUri), {
        timeoutDuration: 2_000, // Không chờ Keycloak quá 2 giây
        cooldownDuration: 30_000, // Không tải lại JWKS dồn dập khi gặp token rác
        cacheMaxAge: 10 * 60_000, // Làm mới khóa mỗi 10 phút
      });
    } else {
      throw new Error('JoseTokenVerifier cần jwksUri hoặc jwks');
    }
  }

  async verify(token: string): Promise<Principal> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.keys, {
        issuer: this.options.issuer,
        audience: this.options.audience,
        algorithms: ['RS256', 'PS256', 'ES256'], // Chỉ chấp nhận thuật toán bất đối xứng; chặn "none"/HS256
        clockTolerance: 5, // Cho phép lệch đồng hồ 5 giây
      }));
    } catch (err) {
      // Không tải được JWKS là lỗi phụ thuộc (503), không phải lỗi của người dùng (401)
      if (err instanceof joseErrors.JWKSTimeout) {
        throw new DependencyUnavailableError('keycloak-jwks');
      }
      throw new UnauthenticatedError('Token không hợp lệ hoặc đã hết hạn');
    }
    return toPrincipal(payload, token);
  }
}

// Phân biệt người dùng và service account của Keycloak
export function toPrincipal(payload: JWTPayload, token: string): Principal {
  const sub = payload.sub;
  if (!sub) throw new UnauthenticatedError('Token thiếu claim sub');

  const username = typeof payload.preferred_username === 'string' ? payload.preferred_username : '';
  const clientIdClaim = typeof payload.client_id === 'string' ? payload.client_id : undefined;
  const azp = typeof payload.azp === 'string' ? payload.azp : undefined;
  // Token client_credentials của Keycloak: username "service-account-<clientId>" và/hoặc claim client_id
  const isService = username.startsWith('service-account-') || clientIdClaim !== undefined;

  if (isService) {
    const clientId = clientIdClaim ?? azp ?? username.replace('service-account-', '');
    return {
      type: 'service',
      id: `services/${clientId}`,
      subject: sub,
      token,
      claims: payload as Record<string, unknown>,
    };
  }

  return {
    type: 'user',
    id: `users/${sub}`,
    subject: sub,
    email: typeof payload.email === 'string' ? payload.email.toLowerCase() : undefined,
    name: typeof payload.name === 'string' ? payload.name : undefined,
    emailVerified: payload.email_verified === true,
    token,
    claims: payload as Record<string, unknown>,
  };
}
