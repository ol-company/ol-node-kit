import { describe, expect, it } from 'vitest';
import {
  AppError,
  ConflictError,
  DependencyUnavailableError,
  ForbiddenError,
  NotFoundError,
  TooManyRequestsError,
  UnauthenticatedError,
  ValidationError,
} from '../src/index.js';

describe('AppError', () => {
  it('giữ nguyên status, code, message và details', () => {
    const err = new AppError(418, 'teapot', 'Tôi là ấm trà', { hint: 'pha trà' });
    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({
      status: 418,
      code: 'teapot',
      message: 'Tôi là ấm trà',
      details: { hint: 'pha trà' },
    });
  });

  it('details để trống thì là undefined', () => {
    expect(new AppError(400, 'x', 'y').details).toBeUndefined();
  });
});

describe('các lỗi ứng dụng', () => {
  const cases: Array<[string, new () => AppError, number, string]> = [
    ['ValidationError', ValidationError, 400, 'validation_failed'],
    ['UnauthenticatedError', UnauthenticatedError, 401, 'unauthenticated'],
    ['ForbiddenError', ForbiddenError, 403, 'forbidden'],
    ['NotFoundError', NotFoundError, 404, 'not_found'],
    ['ConflictError', ConflictError, 409, 'conflict'],
    ['TooManyRequestsError', TooManyRequestsError, 429, 'too_many_requests'],
  ];

  it.each(cases)('%s có mã HTTP, code và thông báo mặc định đúng', (name, Ctor, status, code) => {
    const err = new Ctor();
    expect(err).toBeInstanceOf(AppError);
    expect(err.name).toBe(name); // Tên lớp con, không phải "AppError"
    expect(err.status).toBe(status);
    expect(err.code).toBe(code);
    expect(err.message).not.toBe('');
  });

  it('cho phép ghi đè thông báo và đính kèm details', () => {
    const validation = new ValidationError('Sai email', [{ path: 'email' }]);
    expect(validation.message).toBe('Sai email');
    expect(validation.details).toEqual([{ path: 'email' }]);

    const forbidden = new ForbiddenError('Cấm', { permission: 'a.b.c' });
    expect(forbidden.message).toBe('Cấm');
    expect(forbidden.details).toEqual({ permission: 'a.b.c' });

    const conflict = new ConflictError('Trùng mã', { field: 'code' });
    expect(conflict.details).toEqual({ field: 'code' });

    expect(new UnauthenticatedError('Hết hạn').message).toBe('Hết hạn');
    expect(new NotFoundError('Không có kho').message).toBe('Không có kho');
    expect(new TooManyRequestsError('Chậm lại').message).toBe('Chậm lại');
  });
});

describe('DependencyUnavailableError', () => {
  it('là lỗi 503 và nêu tên phụ thuộc trong thông báo', () => {
    const err = new DependencyUnavailableError('iam-authorize');
    expect(err).toBeInstanceOf(AppError);
    expect(err.status).toBe(503);
    expect(err.code).toBe('dependency_unavailable');
    expect(err.message).toContain('iam-authorize');
  });

  it('retry-after mặc định 5 giây, ghi đè được', () => {
    expect(new DependencyUnavailableError('db').retryAfterSeconds).toBe(5);
    expect(new DependencyUnavailableError('db', 30).retryAfterSeconds).toBe(30);
  });
});
