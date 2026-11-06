// Middleware HTTP dùng chung: request id + ngữ cảnh, access log, 404 và xử lý lỗi thống nhất.
import { randomUUID } from 'node:crypto';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { requestContext } from '../context.js';
import { AppError, DependencyUnavailableError } from '../errors.js';
import type { Logger } from '../logger.js';
import './express-augment.js';

const REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;

// Gán request id (nhận từ BFF/ALB nếu hợp lệ, không thì tự sinh) và mở ngữ cảnh AsyncLocalStorage
export function requestContextMiddleware(): RequestHandler {
  return (req, res, next) => {
    const incoming = req.header('x-request-id');
    const requestId = incoming && REQUEST_ID.test(incoming) ? incoming : randomUUID();
    req.requestId = requestId;
    res.setHeader('x-request-id', requestId); // Trả lại cho client để đối chiếu khi báo lỗi
    requestContext.run({ requestId }, () => next());
  };
}

// Ghi 1 dòng log cho mỗi request khi phản hồi xong
export function accessLogMiddleware(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      if (req.path.startsWith('/health')) return; // Health check quá nhiều, không cần log
      logger.info(
        {
          method: req.method,
          route: req.route?.path ?? req.path, // Ưu tiên mẫu route (/v1/tenants/:tenantId) để gom nhóm
          status: res.statusCode,
          durationMs: Math.round(durationMs),
        },
        'http_request',
      );
    });
    next();
  };
}

// Phản hồi lỗi chuẩn RFC 9457 (application/problem+json)
function problem(status: number, code: string, title: string, requestId?: string, details?: unknown) {
  return {
    type: `https://errors.ol-platform.dev/${code}`,
    title,
    status,
    code,
    requestId,
    ...(details === undefined ? {} : { details }),
  };
}

export function notFoundHandler(): RequestHandler {
  return (req, res) => {
    res.status(404).type('application/problem+json').json(problem(404, 'not_found', 'Không tìm thấy', req.requestId));
  };
}

export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err, req, res, _next) => {
    if (res.headersSent) return; // Đã gửi một phần phản hồi thì không thể gửi lỗi nữa

    if (err instanceof AppError) {
      if (err instanceof DependencyUnavailableError) res.setHeader('retry-after', String(err.retryAfterSeconds));
      const level = err.status >= 500 ? 'error' : 'info';
      logger[level]({ code: err.code, status: err.status }, err.message);
      res.status(err.status).type('application/problem+json').json(problem(err.status, err.code, err.message, req.requestId, err.details));
      return;
    }

    // Lỗi parse JSON của express.json()
    const e = err as { type?: string; status?: number };
    if (e?.type === 'entity.parse.failed' || e?.type === 'entity.too.large') {
      const status = e.status ?? 400;
      res.status(status).type('application/problem+json').json(problem(status, 'invalid_body', 'Body không hợp lệ', req.requestId));
      return;
    }

    // Lỗi không lường trước: log đầy đủ, nhưng chỉ trả thông báo chung cho client
    logger.error({ err }, 'unhandled_error');
    res.status(500).type('application/problem+json').json(problem(500, 'internal_error', 'Lỗi hệ thống', req.requestId));
  };
}
