import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { AttachmentStatus, type PrismaClient } from '@dailytasks/database';
import { errMsg, logger } from './logger';

/** Upload slots that were requested but never confirmed are removed after this long. */
export const ABANDONED_UPLOAD_AFTER_MS = 24 * 3600_000;

export interface ObjectStore {
  delete(key: string): Promise<void>;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
}

export class S3ObjectStore implements ObjectStore {
  private readonly s3: S3Client;
  constructor(
    private readonly bucket: string,
    region: string,
    endpoint?: string,
    forcePathStyle = false,
  ) {
    this.s3 = new S3Client({ region, endpoint, forcePathStyle });
  }
  async put(key: string, body: Buffer, contentType: string) {
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType, ServerSideEncryption: 'AES256' }));
  }
  async delete(key: string) {
    // DeleteObject is idempotent: a key that was never uploaded is not an error.
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

/**
 * Retention: deletes PENDING attachments (pre-signed upload requested, never confirmed) older
 * than 24 h — the S3 object (if the browser uploaded it) and the row. Confirmed attachments are
 * business records and are kept with their task. Returns the number removed.
 */
export async function cleanupAbandonedUploads(prisma: PrismaClient, store: ObjectStore, now = new Date()): Promise<number> {
  const stale = await prisma.taskAttachment.findMany({
    where: { status: AttachmentStatus.PENDING, createdAt: { lt: new Date(now.getTime() - ABANDONED_UPLOAD_AFTER_MS) } },
    select: { id: true, storageKey: true },
    take: 200,
  });
  let removed = 0;
  for (const a of stale) {
    try {
      await store.delete(a.storageKey);
      // Conditional: never delete a row that was confirmed in the meantime.
      const r = await prisma.taskAttachment.deleteMany({ where: { id: a.id, status: AttachmentStatus.PENDING } });
      removed += r.count;
    } catch (e) {
      logger.warn('abandoned upload cleanup failed', { attachmentId: a.id, error: errMsg(e) });
    }
  }
  // Manual Documents Center uploads that were never confirmed.
  const staleDocs = await prisma.projectDocument.findMany({
    where: { status: AttachmentStatus.PENDING, source: 'MANUAL', createdAt: { lt: new Date(now.getTime() - ABANDONED_UPLOAD_AFTER_MS) } },
    select: { id: true, storageKey: true },
    take: 200,
  });
  for (const d of staleDocs) {
    try {
      if (d.storageKey) await store.delete(d.storageKey);
      removed += (await prisma.projectDocument.deleteMany({ where: { id: d.id, status: AttachmentStatus.PENDING } })).count;
    } catch (e) {
      logger.warn('abandoned document cleanup failed', { documentId: d.id, error: errMsg(e) });
    }
  }
  if (removed) logger.info('removed abandoned uploads', { count: removed });
  return removed;
}
