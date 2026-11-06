// SecureRouter: cách DUY NHẤT để khai báo route trong service.
// Mỗi route bắt buộc có policy:
//   - public          : không cần đăng nhập (chỉ health, callback...)
//   - authenticated   : cần token hợp lệ, không cần permission cụ thể
//   - permission      : cần token + IAM cho phép permission trên resource
// Kiểu TypeScript bắt buộc truyền policy → không thể "quên" phân quyền (default deny).
import { Router, type RequestHandler } from 'express';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { requestContext, type Principal } from '../context.js';
import { RESOURCE_PATTERN, RESOURCE_SEGMENT } from '../contracts/authorize.js';
import { ForbiddenError, UnauthenticatedError, ValidationError } from '../errors.js';
import type { Authorizer } from '../authz/authorizer.js';
import type { TokenVerifier } from '../auth/jwt.js';
import type { Logger } from '../logger.js';
import './express-augment.js';

export type RoutePolicy =
  | { kind: 'public' }
  | { kind: 'authenticated' }
  | { kind: 'permission'; permission: string; resource: (params: Record<string, string>) => string };

// Hàm tạo policy cho dễ đọc: policy.permission('warehouse.items.list', p => `tenants/${p.tenantId}`)
export const policy = {
  public: (): RoutePolicy => ({ kind: 'public' }),
  authenticated: (): RoutePolicy => ({ kind: 'authenticated' }),
  permission: (permission: string, resource: (params: Record<string, string>) => string): RoutePolicy => ({
    kind: 'permission',
    permission,
    resource,
  }),
};

export interface RouteDefinition {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
  policy: RoutePolicy;
}

export interface SecureRouterDeps {
  verifier: TokenVerifier;
  authorizer: Authorizer;
  logger?: Logger;
}

export class SecureRouter {
  readonly router: Router = Router();
  readonly definitions: RouteDefinition[] = []; // Danh sách route để test và sinh tài liệu

  constructor(private readonly deps: SecureRouterDeps) {}

  get(path: string, p: RoutePolicy, ...handlers: RequestHandler[]): this {
    return this.add('get', path, p, handlers);
  }
  post(path: string, p: RoutePolicy, ...handlers: RequestHandler[]): this {
    return this.add('post', path, p, handlers);
  }
  put(path: string, p: RoutePolicy, ...handlers: RequestHandler[]): this {
    return this.add('put', path, p, handlers);
  }
  patch(path: string, p: RoutePolicy, ...handlers: RequestHandler[]): this {
    return this.add('patch', path, p, handlers);
  }
  delete(path: string, p: RoutePolicy, ...handlers: RequestHandler[]): this {
    return this.add('delete', path, p, handlers);
  }

  private add(method: RouteDefinition['method'], path: string, p: RoutePolicy, handlers: RequestHandler[]): this {
    this.definitions.push({ method, path, policy: p });
    const chain: RequestHandler[] = [];
    if (p.kind !== 'public') chain.push(this.authenticate);
    if (p.kind === 'permission') chain.push(this.authorize(p));
    this.router[method](path, ...chain, ...handlers);
    return this;
  }

  // Xác thực: đọc "Authorization: Bearer <token>", xác minh, gắn principal vào request
  private readonly authenticate: RequestHandler = async (req, _res, next) => {
    const header = req.header('authorization');
    if (!header || !header.startsWith('Bearer ')) throw new UnauthenticatedError();
    const principal = await this.deps.verifier.verify(header.slice('Bearer '.length).trim());
    req.principal = principal;
    const ctx = requestContext.get();
    if (ctx) ctx.principal = principal; // Logger sẽ tự ghi principal từ đây
    next();
  };

  // Phân quyền: dựng tên tài nguyên từ tham số URL rồi hỏi Authorizer
  private authorize(p: Extract<RoutePolicy, { kind: 'permission' }>): RequestHandler {
    return async (req, _res, next) => {
      // Express giải mã %2F thành "/" trong tham số → kiểm tra để chặn "tenants/a/../b"
      for (const [name, value] of Object.entries(req.params)) {
        if (typeof value !== 'string' || !RESOURCE_SEGMENT.test(value)) {
          throw new ValidationError(`Tham số đường dẫn không hợp lệ: ${name}`);
        }
      }
      const resource = p.resource(req.params as Record<string, string>);
      if (!RESOURCE_PATTERN.test(resource)) throw new ValidationError('Tên tài nguyên không hợp lệ');
      const principal = req.principal!; // authenticate đã chạy trước
      const decision = await this.deps.authorizer.check({
        principal: principal.id,
        permission: p.permission,
        resource,
      });
      if (!decision.allow) {
        this.deps.logger?.info(
          { permission: p.permission, resource, reason: decision.reason },
          'authz_denied',
        );
        throw new ForbiddenError(undefined, { reason: decision.reason, permission: p.permission });
      }
      next();
    };
  }
}

// ---------------------------------------------------------------------------
// handle(): bọc handler — validate body/params/query bằng Zod, gọi use case, trả JSON.
// ---------------------------------------------------------------------------
export interface HandlerContext<B, P, Q> {
  body: B;
  params: P;
  query: Q;
  principal: Principal;
  req: Request;
  res: Response;
}

export function handle<B = undefined, P = Record<string, string>, Q = undefined>(
  schemas: { body?: z.ZodType<B>; params?: z.ZodType<P>; query?: z.ZodType<Q> },
  fn: (ctx: HandlerContext<B, P, Q>) => unknown,
  options: { status?: number } = {},
): RequestHandler {
  return async (req, res) => {
    if (!req.principal) throw new UnauthenticatedError();
    const body = schemas.body ? parse(schemas.body, req.body, 'body') : (undefined as B);
    const params = schemas.params ? parse(schemas.params, req.params, 'params') : (req.params as P);
    const query = schemas.query ? parse(schemas.query, req.query, 'query') : (undefined as Q);
    const result = await fn({ body, params, query, principal: req.principal, req, res });
    if (res.headersSent) return;
    if (result === undefined) res.status(204).end(); // Không có nội dung trả về
    else res.status(options.status ?? 200).json(result);
  };
}

function parse<T>(schema: z.ZodType<T>, value: unknown, where: string): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new ValidationError(`${where} không hợp lệ`, r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  return r.data;
}
