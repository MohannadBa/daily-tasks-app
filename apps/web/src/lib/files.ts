import { uploadAttachment, type AttachmentDto } from '@dailytasks/api-client';
import { api } from './api';

// Mirrors packages/config (kept local so the browser bundle stays free of zod/server code).
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  pdf: 'application/pdf',
  txt: 'text/plain',
  csv: 'text/csv',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
export const ALLOWED_EXTENSIONS = Object.keys(MIME_BY_EXT);

export function mimeFor(fileName: string): string | null {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXT[ext] ?? null;
}

export function validateFile(f: { name: string; size: number }): string | null {
  if (!mimeFor(f.name)) return `"${f.name}" is not an allowed file type`;
  if (f.size > MAX_FILE_BYTES) return `"${f.name}" is larger than 25 MB`;
  if (f.size === 0) return `"${f.name}" is empty`;
  return null;
}

/** Uploads files for a task through pre-signed S3 URLs and returns the confirmed attachments. */
export async function uploadFiles(taskId: string, files: File[]): Promise<AttachmentDto[]> {
  const out: AttachmentDto[] = [];
  for (const f of files) {
    // Normalise content type from the extension (browsers sometimes send "" or vendor types).
    out.push(await uploadAttachment(api, taskId, { name: f.name, type: mimeFor(f.name)!, size: f.size, body: f }));
  }
  return out;
}

export async function openAttachment(id: string) {
  const { url } = await api.attachments.downloadUrl(id);
  window.open(url, '_blank', 'noopener,noreferrer');
}
