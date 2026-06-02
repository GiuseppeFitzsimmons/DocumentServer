import type { Request, Response, NextFunction } from 'express';
declare module 'express-session' {
    interface SessionData {
        userId: string;
    }
}
export declare function requireAuth(req: Request, res: Response, next: NextFunction): void;
//# sourceMappingURL=middleware.d.ts.map