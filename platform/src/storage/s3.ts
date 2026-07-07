import { Readable } from 'stream';
import { createReadStream, createWriteStream } from 'fs';
import { mkdir, unlink, readFile } from 'fs/promises';
import path from 'path';
import { config } from '../config.js';
import { pipeline } from 'stream/promises';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

const STORAGE_DIR = config.FILE_STORAGE_PATH;
const USE_S3 = config.STORAGE_BACKEND === 's3';

const s3Client = (USE_S3 || config.OVH_S3_ENDPOINT) ? new S3Client({
  endpoint: config.OVH_S3_ENDPOINT,
  region: config.OVH_S3_REGION,
  credentials: {
    accessKeyId: config.OVH_S3_ACCESS_KEY,
    secretAccessKey: config.OVH_S3_SECRET_KEY,
  },
  forcePathStyle: true,
}) : null;

const BUCKET = config.OVH_S3_BUCKET;

function s3Key(key: string): string {
  return `files/${key}`;
}

// --- Local filesystem helpers ---

async function ensureDir(filePath: string): Promise<void> {
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
  } catch (err: any) {
    if (err.code !== 'EEXIST') throw err;
  }
}

function resolvePath(key: string): string {
  const normalized = path.normalize(key).replace(/^(\.\.[/\\])+/, '');
  return path.join(STORAGE_DIR, normalized);
}

// --- Upload ---

export async function upload(
  key: string,
  body: Buffer | Readable,
  contentType: string
): Promise<void> {
  if (USE_S3) {
    let buffer: Buffer;
    if (Buffer.isBuffer(body)) {
      buffer = body;
    } else {
      const chunks: Buffer[] = [];
      for await (const chunk of body) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      buffer = Buffer.concat(chunks);
    }
    await s3Client!.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: s3Key(key),
      Body: buffer,
      ContentType: contentType,
    }));
  } else {
    const filePath = resolvePath(key);
    await ensureDir(filePath);

    if (Buffer.isBuffer(body)) {
      const { writeFile } = await import('fs/promises');
      await writeFile(filePath, body);
    } else {
      const writeStream = createWriteStream(filePath);
      await pipeline(body, writeStream);
    }

    // Async replication to S3 (fire-and-forget backup)
    if (s3Client) {
      const buffer = Buffer.isBuffer(body) ? body : await readFile(resolvePath(key));
      s3Client.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: s3Key(key),
        Body: buffer,
        ContentType: contentType,
      })).catch(err => console.error('[storage] S3 replication failed:', err));
    }
  }
}

// --- Download ---

export async function download(key: string): Promise<Readable> {
  if (USE_S3) {
    const response = await s3Client!.send(new GetObjectCommand({
      Bucket: BUCKET,
      Key: s3Key(key),
    }));
    return response.Body as Readable;
  } else {
    const filePath = resolvePath(key);
    return createReadStream(filePath);
  }
}

// --- Remove ---

export async function remove(key: string): Promise<void> {
  if (USE_S3) {
    await s3Client!.send(new DeleteObjectCommand({
      Bucket: BUCKET,
      Key: s3Key(key),
    }));
  } else {
    const filePath = resolvePath(key);
    try {
      await unlink(filePath);
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw err;
    }

    // Async replication
    if (s3Client) {
      s3Client.send(new DeleteObjectCommand({
        Bucket: BUCKET,
        Key: s3Key(key),
      })).catch(err => console.error('[storage] S3 replication delete failed:', err));
    }
  }
}
