import { createReadStream, createWriteStream } from 'fs';
import { mkdir, unlink, readFile } from 'fs/promises';
import path from 'path';
import { config } from '../config.js';
import { pipeline } from 'stream/promises';
import { replicateUpload, replicateDelete } from './replicate.js';
const STORAGE_DIR = config.FILE_STORAGE_PATH;
async function ensureDir(filePath) {
    await mkdir(path.dirname(filePath), { recursive: true });
}
function resolvePath(key) {
    // Prevent path traversal
    const normalized = path.normalize(key).replace(/^(\.\.[/\\])+/, '');
    return path.join(STORAGE_DIR, normalized);
}
export async function upload(key, body, contentType) {
    const filePath = resolvePath(key);
    await ensureDir(filePath);
    if (Buffer.isBuffer(body)) {
        const { writeFile } = await import('fs/promises');
        await writeFile(filePath, body);
        replicateUpload(key, body, contentType);
    }
    else {
        const writeStream = createWriteStream(filePath);
        await pipeline(body, writeStream);
        // Read back the written file for replication
        const written = await readFile(filePath);
        replicateUpload(key, written, contentType);
    }
}
export async function download(key) {
    const filePath = resolvePath(key);
    return createReadStream(filePath);
}
export async function remove(key) {
    const filePath = resolvePath(key);
    try {
        await unlink(filePath);
    }
    catch (err) {
        if (err.code !== 'ENOENT')
            throw err;
    }
    replicateDelete(key);
}
//# sourceMappingURL=s3.js.map