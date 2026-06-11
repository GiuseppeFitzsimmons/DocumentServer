export declare const callbackRouter: import("express-serve-static-core").Router;
export interface CallbackPayload {
    status: number;
    url?: string;
    key?: string;
    changesurl?: string;
    history?: {
        changes: object[];
        serverVersion: string;
    };
    users?: string[];
    actions?: Array<{
        type: number;
        userid: string;
    }>;
}
//# sourceMappingURL=callback.d.ts.map