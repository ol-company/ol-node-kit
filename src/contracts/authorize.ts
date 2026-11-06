// HỢP ĐỒNG (contract) giữa service gọi và IAM cho API POST /internal/v1/authorize.
// Cả phía gọi (AuthzHttpClient) lẫn phía cung cấp (ol-iam-service) đều validate bằng đúng
// các schema này — test hợp đồng ở hai repo dùng chung một nguồn sự thật.
import { z } from 'zod';

// Đoạn tên tài nguyên: chữ, số, chấm, gạch dưới, gạch ngang — không có "/" hay ký tự lạ
export const RESOURCE_SEGMENT = /^[A-Za-z0-9._-]{1,128}$/;
// Tên tài nguyên: "platform" hoặc "tenants/<id>/<loại>/<id>..."
export const RESOURCE_PATTERN =
  /^(platform|tenants\/[A-Za-z0-9._-]{1,128}(\/[A-Za-z0-9._-]{1,128})*)$/;
// Định danh principal: "users/<uuid>" | "services/<clientId>" | "groups/<uuid>"
export const PRINCIPAL_PATTERN = /^(users|services|groups)\/[A-Za-z0-9._-]{1,128}$/;
// Permission dạng service.resource.verb, ví dụ warehouse.items.list
export const PERMISSION_PATTERN = /^[a-z]+\.[a-zA-Z]+\.[a-zA-Z]+$/;

export const AuthorizeRequestSchema = z.object({
  principal: z.string().regex(PRINCIPAL_PATTERN),
  permission: z.string().regex(PERMISSION_PATTERN),
  resource: z.string().max(1024).regex(RESOURCE_PATTERN),
});

export const AuthorizeResponseSchema = z.object({
  allow: z.boolean(),
  // Lý do để debug/audit; không dùng để quyết định phía client
  reason: z.enum([
    'binding',
    'no-binding',
    'not-member',
    'membership-disabled',
    'principal-disabled',
    'tenant-suspended',
    'mfa-required',
    'unknown-permission',
  ]),
  policyVersion: z.number().int().nonnegative(),
});

export type AuthorizeRequest = z.infer<typeof AuthorizeRequestSchema>;
export type AuthorizeResponse = z.infer<typeof AuthorizeResponseSchema>;
