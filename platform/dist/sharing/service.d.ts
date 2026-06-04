export interface SharePermissions {
    edit: boolean;
    download: boolean;
    print: boolean;
    copy: boolean;
    comment: boolean;
    review: boolean;
    chat: boolean;
    fillForms: boolean;
}
export interface ShareRecord {
    id: string;
    fileId: string;
    ownerId: string;
    inviteeId: string;
    permissions: SharePermissions;
    createdAt: Date;
}
export interface ShareListEntry extends ShareRecord {
    inviteeEmail: string;
    inviteeDisplayName: string;
}
export interface SharedFileEntry {
    fileId: string;
    fileName: string;
    fileType: string;
    ownerDisplayName: string;
    permissions: SharePermissions;
    sharedAt: Date;
}
export declare function createShare(fileId: string, ownerId: string, inviteeEmail: string, permissions: SharePermissions): Promise<ShareRecord>;
export declare function getShare(fileId: string, inviteeId: string): Promise<ShareRecord | null>;
export declare function listSharesForFile(fileId: string, ownerId: string): Promise<ShareListEntry[]>;
export declare function listSharedFiles(inviteeId: string): Promise<SharedFileEntry[]>;
export declare function updateSharePermissions(shareId: string, ownerId: string, permissions: SharePermissions): Promise<ShareRecord>;
export declare function revokeShare(shareId: string, ownerId: string): Promise<void>;
export declare function deleteSharesForFile(fileId: string): Promise<void>;
export interface ShareUserEntry {
    id: string;
    name: string;
    email: string;
}
export declare function listShareUsersForFile(fileId: string, userId: string): Promise<ShareUserEntry[]>;
//# sourceMappingURL=service.d.ts.map