import { Readable } from 'stream';
export declare function upload(key: string, body: Buffer | Readable, contentType: string): Promise<void>;
export declare function download(key: string): Promise<Readable>;
export declare function remove(key: string): Promise<void>;
//# sourceMappingURL=s3.d.ts.map