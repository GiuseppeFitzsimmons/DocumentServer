import { createReadStream, createWriteStream } from 'fs';
import { mkdir, unlink } from 'fs/promises';
import path from 'path';
import { config } from '../config.js';
import { pipeline } from 'stream/promises';
const STORAGE_DIR = config.FILE_STORAGE_PATH;
async function ensureDir(filePath) {
    await mkdir(path.dirname(filePath), { recursive: true });
}
function resolvePath(key) {
    // Prevent path traversal
    const normalized = path.normalize(key).replace(/^(\.\.[/\\])+/, '');
    return path.join(STORAGE_DIR, normalized);
}
export async function upload(key, body, _contentType) {
    const filePath = resolvePath(key);
    await ensureDir(filePath);
    if (Buffer.isBuffer(body)) {
        const { writeFile } = await import('fs/promises');
        await writeFile(filePath, body);
    }
    else {
        const writeStream = createWriteStream(filePath);
        await pipeline(body, writeStream);
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
}
//# sourceMappingURL=s3.js.map