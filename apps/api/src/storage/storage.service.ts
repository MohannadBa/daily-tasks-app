import { Global, Inject, Injectable, Module } from '@nestjs/common';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { ApiEnv } from '@dailytasks/config';
import { API_ENV } from '../config/config.module';

export interface StoredObjectInfo {
  sizeBytes: number;
  contentType?: string;
}

/** Abstract so tests can swap in an in-memory implementation. */
export abstract class StorageService {
  abstract presignUpload(key: string, contentType: string, sizeBytes: number, ttlSeconds: number): Promise<{ url: string; headers: Record<string, string> }>;
  abstract presignDownload(key: string, fileName: string, ttlSeconds: number): Promise<string>;
  /** Returns null if the object does not exist. */
  abstract head(key: string): Promise<StoredObjectInfo | null>;
}

/**
 * Private S3 bucket access via pre-signed URLs. Objects are never public.
 * Two clients: one for server-side calls (internal endpoint), one for signing URLs that
 * browsers/phones will call (S3_PUBLIC_ENDPOINT, e.g. http://localhost:4566 with LocalStack).
 */
@Injectable()
export class S3StorageService extends StorageService {
  private readonly internal: S3Client;
  private readonly signer: S3Client;
  private readonly bucket: string;

  constructor(@Inject(API_ENV) env: ApiEnv) {
    super();
    const base = {
      region: env.AWS_REGION,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      // SDK >=3.729 otherwise adds a CRC32 checksum to pre-signed PUT URLs that browsers/phones cannot supply.
      requestChecksumCalculation: 'WHEN_REQUIRED' as const,
      responseChecksumValidation: 'WHEN_REQUIRED' as const,
    };
    this.internal = new S3Client({ ...base, endpoint: env.AWS_ENDPOINT_URL });
    this.signer = new S3Client({ ...base, endpoint: env.S3_PUBLIC_ENDPOINT ?? env.AWS_ENDPOINT_URL });
    this.bucket = env.S3_BUCKET;
  }

  async presignUpload(key: string, contentType: string, sizeBytes: number, ttlSeconds: number) {
    const cmd = new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType, ContentLength: sizeBytes });
    // Content-Type and Content-Length are part of the signature, so the client cannot swap them.
    const url = await getSignedUrl(this.signer, cmd, { expiresIn: ttlSeconds, signableHeaders: new Set(['content-type', 'content-length']) });
    return { url, headers: { 'Content-Type': contentType } };
  }

  async presignDownload(key: string, fileName: string, ttlSeconds: number) {
    const safe = fileName.replace(/["\\\r\n]/g, '_');
    const cmd = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ResponseContentDisposition: `attachment; filename="${safe.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    });
    return getSignedUrl(this.signer, cmd, { expiresIn: ttlSeconds });
  }

  async head(key: string): Promise<StoredObjectInfo | null> {
    try {
      const res = await this.internal.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { sizeBytes: res.ContentLength ?? 0, contentType: res.ContentType };
    } catch (e) {
      const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404 || (e as Error).name === 'NotFound') return null;
      throw e;
    }
  }
}

@Global()
@Module({ providers: [{ provide: StorageService, useClass: S3StorageService }], exports: [StorageService] })
export class StorageModule {}
