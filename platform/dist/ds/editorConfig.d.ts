import type { FileRecord } from '../storage/metadata.js';
import type { SharePermissions } from '../sharing/service.js';
export interface SharingSettingsEntry {
    user: string;
    permissions: string;
    isLink: boolean;
}
export interface EditorConfigParams {
    file: FileRecord;
    user: {
        id: string;
        name: string;
    };
    sharePermissions?: SharePermissions;
    sharingSettings?: SharingSettingsEntry[];
    isOwner?: boolean;
    hasVersions?: boolean;
}
export declare function buildEditorConfig(params: EditorConfigParams): object;
//# sourceMappingURL=editorConfig.d.ts.map