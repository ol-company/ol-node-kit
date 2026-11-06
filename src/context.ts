// Ngữ cảnh theo request, truyền ngầm qua mọi lời gọi async bằng AsyncLocalStorage.
// Logger đọc từ đây để tự gắn requestId/principal vào mọi dòng log.
import { AsyncLocalStorage } from 'node:async_hooks';

// Danh tính đã xác minh của bên gọi
export interface Principal {
  type: 'user' | 'service';
  id: string; // Định danh dùng trong IAM: "users/<sub>" hoặc "services/<clientId>"
  subject: string; // Claim "sub" của token
  email?: string;
  name?: string;
  emailVerified?: boolean;
  token: string; // Access token gốc — chỉ dùng để chuyển tiếp, không bao giờ ghi log
  claims: Record<string, unknown>;
}

export interface RequestContext {
  requestId: string;
  principal?: Principal;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const requestContext = {
  // Chạy fn bên trong một ngữ cảnh mới
  run<T>(ctx: RequestContext, fn: () => T): T {
    return storage.run(ctx, fn);
  },
  // Lấy ngữ cảnh hiện tại (undefined nếu ngoài request, ví dụ job nền)
  get(): RequestContext | undefined {
    return storage.getStore();
  },
};
