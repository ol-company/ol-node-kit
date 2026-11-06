// Các lỗi ứng dụng có mã HTTP rõ ràng. Use case ném lỗi này; middleware lỗi chuyển thành
// phản hồi application/problem+json (RFC 9457). Không có lỗi nào lộ stack trace ra client.

export class AppError extends Error {
  readonly status: number; // Mã HTTP trả về
  readonly code: string; // Mã lỗi ổn định cho client lập trình (không dịch)
  readonly details: unknown; // Thông tin thêm an toàn để trả về (ví dụ danh sách field sai)

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = new.target.name; // Tên lớp con, ví dụ "ForbiddenError"
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Dữ liệu không hợp lệ', details?: unknown) {
    super(400, 'validation_failed', message, details);
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = 'Chưa xác thực') {
    super(401, 'unauthenticated', message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Không có quyền thực hiện thao tác này', details?: unknown) {
    super(403, 'forbidden', message, details);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Không tìm thấy tài nguyên') {
    super(404, 'not_found', message);
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Xung đột dữ liệu', details?: unknown) {
    super(409, 'conflict', message, details);
  }
}

export class TooManyRequestsError extends AppError {
  constructor(message = 'Quá nhiều yêu cầu') {
    super(429, 'too_many_requests', message);
  }
}

// Phụ thuộc (IAM, Keycloak, DB) không phản hồi → 503 để client/ALB biết có thể thử lại sau
export class DependencyUnavailableError extends AppError {
  readonly retryAfterSeconds: number;
  constructor(dependency: string, retryAfterSeconds = 5) {
    super(503, 'dependency_unavailable', `Phụ thuộc tạm thời không khả dụng: ${dependency}`);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
