import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import { config } from '../config.js';

const s3 = new S3Client({
  endpoint: config.S3_ENDPOINT,
  region: config.S3_REGION,
  credentials: {
    accessKeyId: config.S3_ACCESS_KEY_ID,
    secretAccessKey: config.S3_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
});

export async function upload(
  key: string,
  body: Buffer | Readable,
  contentType: string
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: config.S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );
}

export async function download(key: string): Promise<Readable> {
  const res = await s3.send(
    new GetObjectCommand({
      Bucket: config.S3_BUCKET,
      Key: key,
    })
  );
  return res.Body as Readable;
}

export async function remove(key: string): Promise<void> {
  await s3.send(
    new DeleteObjectCommand({
      Bucket: config.S3_BUCKET,
      Key: key,
    })
  );
}
