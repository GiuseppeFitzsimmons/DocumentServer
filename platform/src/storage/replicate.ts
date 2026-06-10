import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import { config } from '../config.js';

const enabled =
  config.OVH_S3_ENDPOINT &&
  config.OVH_S3_BUCKET &&
  config.OVH_S3_ACCESS_KEY &&
  config.OVH_S3_SECRET_KEY;

const client = enabled
  ? new S3Client({
      endpoint: config.OVH_S3_ENDPOINT,
      region: config.OVH_S3_REGION,
      credentials: {
        accessKeyId: config.OVH_S3_ACCESS_KEY,
        secretAccessKey: config.OVH_S3_SECRET_KEY,
      },
      forcePathStyle: true,
    })
  : null;

function logError(operation: string, key: string, err: unknown) {
  console.error(`[replicate] ${operation} failed for key="${key}":`, err);
}

/**
 * Asynchronously replicate a file upload to OVH Object Storage.
 * Fire-and-forget — does not block or throw to the caller.
 */
export function replicateUpload(key: string, body: Buffer, contentType: string): void {
  if (!client) return;

  const command = new PutObjectCommand({
    Bucket: config.OVH_S3_BUCKET,
    Key: `files/${key}`,
    Body: body,
    ContentType: contentType,
  });

  client.send(command).catch((err) => logError('upload', key, err));
}

/**
 * Asynchronously replicate a file deletion to OVH Object Storage.
 * Fire-and-forget — does not block or throw to the caller.
 */
export function replicateDelete(key: string): void {
  if (!client) return;

  const command = new DeleteObjectCommand({
    Bucket: config.OVH_S3_BUCKET,
    Key: `files/${key}`,
  });

  client.send(command).catch((err) => logError('delete', key, err));
}
