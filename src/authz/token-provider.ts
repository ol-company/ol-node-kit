// Lấy access token cho chính service (OAuth 2.0 client credentials) và cache tới gần hết hạn.
// Dùng khi service gọi service khác mà không có người dùng (ví dụ gọi IAM authorize).
import { DependencyUnavailableError } from '../errors.js';

export interface TokenProvider {
  getToken(): Promise<string>;
}

export interface ClientCredentialsOptions {
  tokenEndpoint: string; // http://keycloak:8080/realms/ol/protocol/openid-connect/token
  clientId: string;
  clientSecret: string; // Đến từ Secrets Manager qua biến môi trường, không hard-code
  fetchImpl?: typeof fetch; // Thay được trong test
  timeoutMs?: number;
}

export class ClientCredentialsTokenProvider implements TokenProvider {
  private cached?: { token: string; expiresAt: number };
  private inflight?: Promise<string>; // Gộp các lời gọi đồng thời thành một (single-flight)

  constructor(private readonly options: ClientCredentialsOptions) {}

  async getToken(): Promise<string> {
    // Còn hạn hơn 30 giây thì dùng lại
    if (this.cached && this.cached.expiresAt - 30_000 > Date.now()) return this.cached.token;
    this.inflight ??= this.fetchToken().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async fetchToken(): Promise<string> {
    const f = this.options.fetchImpl ?? fetch;
    // HTTP Basic: base64(clientId:clientSecret) theo RFC 6749 mục 2.3.1
    const basic = Buffer.from(
      `${encodeURIComponent(this.options.clientId)}:${encodeURIComponent(this.options.clientSecret)}`,
    ).toString('base64');
    let res: Response;
    try {
      res = await f(this.options.tokenEndpoint, {
        method: 'POST',
        headers: {
          authorization: `Basic ${basic}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ grant_type: 'client_credentials' }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 2_000),
      });
    } catch {
      throw new DependencyUnavailableError('keycloak-token');
    }
    if (!res.ok) throw new DependencyUnavailableError(`keycloak-token (HTTP ${res.status})`);
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new DependencyUnavailableError('keycloak-token (không có access_token)');
    this.cached = {
      token: body.access_token,
      expiresAt: Date.now() + (body.expires_in ?? 60) * 1_000,
    };
    return body.access_token;
  }
}
