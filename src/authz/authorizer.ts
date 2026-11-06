// Phân quyền phía service nghiệp vụ.
//  - Authorizer: cổng (port) trừu tượng "principal X có permission P trên resource R không?"
//  - HttpAuthorizer: hỏi IAM qua HTTP (timeout + retry có giới hạn)
//  - CachingAuthorizer: decorator thêm cache có TTL, fail closed khi IAM lỗi
// Tách thành nhiều lớp nhỏ theo Single Responsibility; ghép bằng composition.
import {
  AuthorizeRequestSchema,
  AuthorizeResponseSchema,
  type AuthorizeRequest,
  type AuthorizeResponse,
} from '../contracts/authorize.js';
import { DependencyUnavailableError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { TokenProvider } from './token-provider.js';

export type AuthzInput = AuthorizeRequest;
export type AuthzDecision = AuthorizeResponse;

export interface Authorizer {
  check(input: AuthzInput): Promise<AuthzDecision>;
}

export interface HttpAuthorizerOptions {
  baseUrl: string; // URL nội bộ của IAM, ví dụ http://iam-service:3000
  tokenProvider: TokenProvider;
  timeoutMs?: number; // Mặc định 300 ms
  fetchImpl?: typeof fetch;
}

export class HttpAuthorizer implements Authorizer {
  constructor(private readonly options: HttpAuthorizerOptions) {}

  async check(input: AuthzInput): Promise<AuthzDecision> {
    const body = AuthorizeRequestSchema.parse(input); // Gửi đúng hợp đồng
    // Tối đa 2 lần thử: authorize chỉ đọc nên retry an toàn (idempotent)
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        return await this.callOnce(body);
      } catch (err) {
        if (attempt === 2) throw err;
        // Chờ ngẫu nhiên 50–150 ms (jitter) để không dồn tải lên IAM cùng lúc
        await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));
      }
    }
    throw new DependencyUnavailableError('iam-authorize');
  }

  private async callOnce(body: AuthorizeRequest): Promise<AuthzDecision> {
    const f = this.options.fetchImpl ?? fetch;
    const token = await this.options.tokenProvider.getToken();
    let res: Response;
    try {
      res = await f(`${this.options.baseUrl}/internal/v1/authorize`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 300),
      });
    } catch {
      throw new DependencyUnavailableError('iam-authorize');
    }
    if (!res.ok) throw new DependencyUnavailableError(`iam-authorize (HTTP ${res.status})`);
    // Kiểm phản hồi theo hợp đồng — IAM trả sai định dạng coi như lỗi phụ thuộc
    const parsed = AuthorizeResponseSchema.safeParse(await res.json());
    if (!parsed.success) throw new DependencyUnavailableError('iam-authorize (sai hợp đồng)');
    return parsed.data;
  }
}

export interface CachingAuthorizerOptions {
  allowTtlMs?: number; // Mặc định 30 giây — thời gian tối đa để thay đổi quyền có hiệu lực
  denyTtlMs?: number; // Mặc định 5 giây — quyền vừa được cấp sẽ có hiệu lực nhanh
  maxEntries?: number; // Giới hạn bộ nhớ
  logger?: Logger;
}

export class CachingAuthorizer implements Authorizer {
  private readonly cache = new Map<string, { decision: AuthzDecision; expiresAt: number }>();
  private readonly allowTtl: number;
  private readonly denyTtl: number;
  private readonly maxEntries: number;

  constructor(
    private readonly inner: Authorizer,
    private readonly options: CachingAuthorizerOptions = {},
  ) {
    this.allowTtl = options.allowTtlMs ?? 30_000;
    this.denyTtl = options.denyTtlMs ?? 5_000;
    this.maxEntries = options.maxEntries ?? 10_000;
  }

  async check(input: AuthzInput): Promise<AuthzDecision> {
    const key = `${input.principal}|${input.permission}|${input.resource}`;
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > now) return hit.decision;

    try {
      const decision = await this.inner.check(input);
      this.store(key, decision, now);
      return decision;
    } catch (err) {
      // FAIL CLOSED: không có quyết định hợp lệ trong cache → từ chối bằng 503, không bao giờ cho qua
      this.options.logger?.warn({ err, key }, 'authorize thất bại, từ chối (fail closed)');
      throw err instanceof DependencyUnavailableError
        ? err
        : new DependencyUnavailableError('iam-authorize');
    }
  }

  private store(key: string, decision: AuthzDecision, now: number): void {
    // Map giữ thứ tự chèn → xóa phần tử cũ nhất khi đầy (gần đúng LRU, đủ dùng)
    if (this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.delete(key);
    this.cache.set(key, {
      decision,
      expiresAt: now + (decision.allow ? this.allowTtl : this.denyTtl),
    });
  }

  clear(): void {
    this.cache.clear();
  }
}
