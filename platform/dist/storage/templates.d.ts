export declare const BLANK_DOCX: Buffer<ArrayBuffer>;
export declare const BLANK_XLSX: Buffer<ArrayBuffer>;
export type DocumentType = 'docx' | 'xlsx';
export declare function getTemplate(type: DocumentType): {
    buffer: Buffer;
    mimeType: string;
};
export declare function isValidDocumentType(type: string): type is DocumentType;
//# sourceMappingURL=templates.d.ts.map