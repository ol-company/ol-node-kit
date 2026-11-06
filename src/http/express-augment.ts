// Bổ sung kiểu cho đối tượng Request của Express (declaration merging).
// Import file này (qua index.ts) là đủ để mọi service có req.requestId và req.principal có kiểu.
import type { Principal } from '../context.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string; // Gán bởi requestContextMiddleware
      principal?: Principal; // Gán sau khi xác thực token thành công
    }
  }
}

export {};
