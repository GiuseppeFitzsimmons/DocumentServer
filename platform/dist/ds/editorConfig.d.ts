import type { FileRecord } from '../storage/metadata.js';
interface EditorConfigParams {
    file: FileRecord;
    user: {
        id: string;
        name: string;
    };
    publicBaseUrl?: string;
}
export declare function buildEditorConfig(params: EditorConfigParams): object;
export {};
//# sourceMappingURL=editorConfig.d.ts.map