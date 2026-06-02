export interface FileRecord {
    id: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
    userId: string;
    folderId: string | null;
    s3Key: string;
    createdAt: Date;
    updatedAt: Date;
}
export interface FolderRecord {
    id: string;
    name: string;
    userId: string;
    parentId: string | null;
    createdAt: Date;
    updatedAt: Date;
}
export declare function createFile(params: {
    name: string;
    mimeType: string;
    sizeBytes: number;
    userId: string;
    folderId: string | null;
    s3Key: string;
}): Promise<FileRecord>;
export declare function getFile(id: string): Promise<FileRecord | null>;
export declare function updateFile(id: string, updates: Partial<Pick<FileRecord, 'name' | 'folderId' | 'sizeBytes'>>): Promise<FileRecord>;
export declare function deleteFile(id: string): Promise<void>;
export declare function listFolder(userId: string, folderId: string | null): Promise<{
    files: FileRecord[];
    folders: FolderRecord[];
}>;
export declare function getRecentFiles(userId: string, limit: number): Promise<FileRecord[]>;
export declare function createFolder(params: {
    name: string;
    userId: string;
    parentId: string | null;
}): Promise<FolderRecord>;
export declare function getFolder(id: string): Promise<FolderRecord | null>;
export declare function renameFolder(id: string, name: string): Promise<FolderRecord>;
export declare function deleteFolder(id: string): Promise<void>;
export declare function folderHasChildren(id: string): Promise<boolean>;
/**
 * Walks the ancestor chain from targetId upward to determine if sourceId
 * is an ancestor of targetId. Used to prevent circular references when
 * moving folders.
 */
export declare function isDescendantOf(targetId: string, sourceId: string): Promise<boolean>;
export declare function moveFolder(id: string, parentId: string | null): Promise<FolderRecord>;
//# sourceMappingURL=metadata.d.ts.map