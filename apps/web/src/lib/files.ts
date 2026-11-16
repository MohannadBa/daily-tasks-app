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

/** Per-file upload progress (0..1) keyed by file index. */
export type UploadProgress = (fileIndex: number, fraction: number) => void;

/** PUT to the pre-signed S3 URL with progress events (fetch has no upload progress). */
function putWithProgress(url: string, headers: Record<string, string>, body: Blob, onProgress: (f: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    for (const [k, v] of Object.entries(headers)) {
      // The browser sets Content-Length itself (it is still part of the signature).
      if (k.toLowerCase() !== 'content-length') xhr.setRequestHeader(k, v);
    }
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`File upload failed (${xhr.status})`)));
    xhr.onerror = () => reject(new Error('File upload failed: network error'));
    xhr.onabort = () => reject(new Error('File upload cancelled'));
    xhr.send(body);
  });
}

/**
 * Uploads files for a task: request a pre-signed URL (type + size are signed), PUT straight to
 * private S3 with progress, then confirm (the API verifies the object). Returns confirmed attachments.
 */
export async function uploadFiles(taskId: string, files: File[], onProgress?: UploadProgress): Promise<AttachmentDto[]> {
  const out: AttachmentDto[] = [];
  for (const [i, f] of files.entries()) {
    // Normalise content type from the extension (browsers sometimes send "" or vendor types).
    const type = mimeFor(f.name)!;
    if (typeof XMLHttpRequest === 'undefined') {
      out.push(await uploadAttachment(api, taskId, { name: f.name, type, size: f.size, body: f }));
      continue;
    }
    const { attachmentId, uploadUrl, headers } = await api.tasks.requestUpload(taskId, { fileName: f.name, contentType: type, sizeBytes: f.size });
    await putWithProgress(uploadUrl, headers, f, (p) => onProgress?.(i, p));
    onProgress?.(i, 1);
    out.push(await api.attachments.confirm(attachmentId));
  }
  return out;
}

export async function openAttachment(id: string) {
  const { url } = await api.attachments.downloadUrl(id);
  window.open(url, '_blank', 'noopener,noreferrer');
}
