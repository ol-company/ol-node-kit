# ol-node-kit

Thư viện dùng chung cho service Node.js của OL-Platform, phát hành lên GitHub Packages với tên `@ol-company/node-kit`.
Service cài bằng alias để code không phụ thuộc tên org: `"@ol/node-kit": "npm:@ol-company/node-kit@^0.1.0"`.

| Module | Nội dung |
|---|---|
| `config` | `loadConfig(schema)` — kiểm tra biến môi trường bằng Zod, sai thì dừng ngay |
| `logger` | pino JSON, tự gắn `requestId`, `principal`, che dữ liệu nhạy cảm |
| `errors` | Lỗi có mã HTTP; middleware chuyển thành `application/problem+json` |
| `auth/jwt` | `JoseTokenVerifier` — xác minh JWT của Keycloak, phân biệt user/service |
| `authz` | `HttpAuthorizer` + `CachingAuthorizer` (cache 30 giây, fail closed), `ClientCredentialsTokenProvider` |
| `contracts/authorize` | Schema hợp đồng API authorize — dùng chung cho IAM và service gọi |
| `http/secure-router` | Mọi route bắt buộc khai báo policy; `handle()` validate input |
| `http/health`, `http/server` | Liveness/readiness, tắt êm khi SIGTERM |
| `db/tenant` | `withTenant()` đặt `app.tenant_id` cho PostgreSQL RLS |
| `otel/register` | Bật OpenTelemetry trước khi app chạy (`node --import @ol/node-kit/otel-register`) |

```powershell
pnpm install; pnpm test; pnpm build
```
Phát hành: merge release PR do release-please tạo → workflow `ci` publish phiên bản mới.
