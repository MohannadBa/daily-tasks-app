'use client';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Archive, Download, Eye, FileImage, FileText, FolderOpen, LayoutGrid, List, Lock, Search, Upload, X } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ProjectDocumentDto } from '@dailytasks/shared-types';
import { api } from '@/lib/api';
import { ALLOWED_EXTENSIONS, openDocument, uploadDocument, validateFile } from '@/lib/files';
import { formatBytes, formatDate, formatDateTime } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { deptName } from '@/lib/labels';
import { errorText, useFeedback } from './feedback';
import { ImageThumb, isPreviewableImage } from './image-preview';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Select, SkeletonList, Textarea } from './ui';

const PREVIEWABLE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf']);
const VIEW_KEY = 'dt_docs_view';

function readView(): 'grid' | 'list' {
  try {
    return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
}

function DocIcon({ doc, className }: { doc: ProjectDocumentDto; className?: string }) {
  return doc.contentType.startsWith('image/') ? <FileImage className={className} aria-hidden /> : <FileText className={className} aria-hidden />;
}

/** In-app preview via a short-lived inline URL (images and PDF only; others download). */
function Preview({ doc, onClose }: { doc: ProjectDocumentDto; onClose: () => void }) {
  const { t } = useT();
  const q = useQuery({ queryKey: ['doc-preview', doc.id], queryFn: () => api.documents.downloadUrl(doc.id, true), staleTime: 60_000 });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6" role="dialog" aria-modal="true" aria-label={doc.title}>
      <div className="absolute inset-0 bg-slate-900/60" onClick={onClose} />
      <div className="dt-fade-in relative flex h-full max-h-[90dvh] w-full max-w-4xl flex-col overflow-hidden rounded-xl bg-white shadow-xl">
        <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
          <p className="min-w-0 truncate text-sm font-semibold text-slate-900">{doc.title}</p>
          <div className="flex items-center gap-1">
            <Button size="sm" variant="secondary" onClick={() => void openDocument(doc.id)}>
              <Download className="h-4 w-4" aria-hidden /> {t('Download')}
            </Button>
            <button onClick={onClose} aria-label={t('Close')} className="flex h-10 w-10 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100">
              <X className="h-5 w-5" aria-hidden />
            </button>
          </div>
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center bg-slate-50">
          {q.isLoading ? (
            <SkeletonList rows={2} className="w-1/2" />
          ) : q.error ? (
            <ErrorBox error={q.error} />
          ) : q.data?.inline && doc.contentType === 'application/pdf' ? (
            <iframe src={q.data.url} title={doc.title} className="h-full w-full" />
          ) : q.data?.inline ? (
            <img src={q.data.url} alt={doc.title} className="max-h-full max-w-full object-contain" />
          ) : (
            <p className="text-sm text-slate-500">{t('Preview is not available for this file type.')}</p>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function UploadForm({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const { t, locale } = useT();
  const { toast } = useFeedback();
  const cats = useQuery({ queryKey: ['document-categories'], queryFn: () => api.documents.categories() });
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [visibility, setVisibility] = useState<'PROJECT_MEMBERS' | 'MANAGERS_ONLY'>('PROJECT_MEMBERS');
  const [progress, setProgress] = useState<number | null>(null);
  const up = useMutation({
    mutationFn: () => uploadDocument(projectId, file!, { title: title.trim(), description: description.trim() || null, categoryId, visibility }, setProgress),
    onSuccess: () => {
      toast(t('Document uploaded'));
      onDone();
    },
    onError: (e) => toast(errorText(e), 'error'),
    onSettled: () => setProgress(null),
  });
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (file && categoryId && title.trim()) up.mutate();
      }}
    >
      <Field label={t('File')} hint={t('Allowed: {ext} · up to 25 MB', { ext: ALLOWED_EXTENSIONS.join(', ') })} error={fileError ?? undefined}>
        <Input
          type="file"
          required
          onChange={(e) => {
            const f = e.target.files?.[0] ?? null;
            const err = f ? validateFile(f) : null;
            setFileError(err ? t(err) : null);
            setFile(err ? null : f);
            if (f && !title) setTitle(f.name.replace(/\.[^.]+$/, ''));
          }}
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('Title')}>
          <Input required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label={t('Category')}>
          <Select required value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">{t('Select a category…')}</option>
            {(cats.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {locale === 'ar' ? c.nameAr : c.nameEn}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label={t('Description')}>
        <Textarea rows={2} maxLength={4000} value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <Field label={t('Who can see it')}>
        <Select value={visibility} onChange={(e) => setVisibility(e.target.value as typeof visibility)}>
          <option value="PROJECT_MEMBERS">{t('Everyone in the project')}</option>
          <option value="MANAGERS_ONLY">{t('Project managers only')}</option>
        </Select>
      </Field>
      {progress !== null && (
        <div className="h-1.5 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full bg-brand-600 transition-all" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      )}
      <Button type="submit" loading={up.isPending} disabled={!file || !categoryId || !title.trim()}>
        <Upload className="h-4 w-4" aria-hidden /> {t('Upload')}
      </Button>
    </form>
  );
}

/**
 * Project Documents Center. Visibility is enforced by the API (employees see "everyone" documents
 * only); approved task deliverables appear automatically (same stored file, never re-uploaded).
 */
export function DocumentsCenter({ projectId, canManage }: { projectId: string; canManage: boolean }) {
  const { t, locale } = useT();
  const qc = useQueryClient();
  const { toast, confirm } = useFeedback();
  const [view, setView] = useState<'grid' | 'list'>('grid');
  useEffect(() => setView(readView()), []);
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [source, setSource] = useState('');
  const [sort, setSort] = useState<'-created' | 'created' | 'title'>('-created');
  const [page, setPage] = useState(1);
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<ProjectDocumentDto | null>(null);
  const cats = useQuery({ queryKey: ['document-categories'], queryFn: () => api.documents.categories() });
  const docs = useQuery({
    queryKey: ['documents', projectId, search, categoryId, source, sort, page],
    queryFn: () => api.documents.list(projectId, { q: search || undefined, categoryId: categoryId || undefined, source: source || undefined, sort, page, pageSize: 24 }),
    placeholderData: keepPreviousData,
  });
  const archive = useMutation({
    mutationFn: (id: string) => api.documents.archive(id),
    onSuccess: () => {
      toast(t('Document archived'));
      return qc.invalidateQueries({ queryKey: ['documents', projectId] });
    },
    onError: (e) => toast(errorText(e), 'error'),
  });
  const setV = (v: 'grid' | 'list') => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* per-viewer convenience only */
    }
  };
  const pages = docs.data ? Math.max(1, Math.ceil(docs.data.total / docs.data.pageSize)) : 1;

  const actions = (d: ProjectDocumentDto) => (
    <div className="flex items-center gap-1">
      {PREVIEWABLE.has(d.contentType) && (
        <button onClick={() => setPreview(d)} aria-label={t('Preview {name}', { name: d.title })} className="flex h-10 w-10 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-brand-700">
          <Eye className="h-4 w-4" aria-hidden />
        </button>
      )}
      <button onClick={() => void openDocument(d.id).catch((e) => toast(errorText(e), 'error'))} aria-label={t('Download {name}', { name: d.title })} className="flex h-10 w-10 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-brand-700">
        <Download className="h-4 w-4" aria-hidden />
      </button>
      {canManage && (
        <button
          onClick={async () => {
            if (await confirm({ title: t('Archive {name}?', { name: d.title }), message: t('It disappears from the Documents Center. Task attachments are not affected.'), confirmLabel: t('Archive'), danger: true }))
              archive.mutate(d.id);
          }}
          aria-label={t('Archive {name}', { name: d.title })}
          className="flex h-10 w-10 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-danger-600"
        >
          <Archive className="h-4 w-4" aria-hidden />
        </button>
      )}
    </div>
  );
  const meta = (d: ProjectDocumentDto) => (
    <div className="flex flex-wrap items-center gap-1.5">
      <Badge tone="gray">{locale === 'ar' ? d.category.nameAr : d.category.nameEn}</Badge>
      {d.source === 'TASK_SUBMISSION' && <Badge tone="blue">{t('From approved task')}</Badge>}
      {d.visibility === 'MANAGERS_ONLY' && (
        <Badge tone="amber">
          <Lock className="me-1 h-3 w-3" aria-hidden />
          {t('Managers only')}
        </Badge>
      )}
    </div>
  );

  return (
    <div className="space-y-4">
      {canManage && (
        <div className="flex justify-end">
          <Button variant={uploading ? 'ghost' : 'primary'} onClick={() => setUploading(!uploading)}>
            {uploading ? t('Close') : (
              <>
                <Upload className="h-4 w-4" aria-hidden /> {t('Upload document')}
              </>
            )}
          </Button>
        </div>
      )}
      {uploading && (
        <Card className="dt-fade-in" title={t('Upload document')}>
          <UploadForm
            projectId={projectId}
            onDone={() => {
              setUploading(false);
              void qc.invalidateQueries({ queryKey: ['documents', projectId] });
            }}
          />
        </Card>
      )}
      <Card>
        <div className="mb-4 grid gap-2 sm:grid-cols-[1fr_auto_auto_auto_auto]">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              setSearch(q.trim());
              setPage(1);
            }}
          >
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Search documents…')} aria-label={t('Search documents…')} />
            <Button type="submit" variant="secondary" aria-label={t('Search')}>
              <Search className="h-4 w-4" aria-hidden />
            </Button>
          </form>
          <Select value={categoryId} onChange={(e) => { setCategoryId(e.target.value); setPage(1); }} aria-label={t('Category')}>
            <option value="">{t('All categories')}</option>
            {(cats.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {locale === 'ar' ? c.nameAr : c.nameEn}
              </option>
            ))}
          </Select>
          <Select value={source} onChange={(e) => { setSource(e.target.value); setPage(1); }} aria-label={t('Source')}>
            <option value="">{t('All sources')}</option>
            <option value="TASK_SUBMISSION">{t('From approved tasks')}</option>
            <option value="MANUAL">{t('Uploaded manually')}</option>
          </Select>
          <Select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label={t('Sort')}>
            <option value="-created">{t('Newest first')}</option>
            <option value="created">{t('Oldest first')}</option>
            <option value="title">{t('Title (A–Z)')}</option>
          </Select>
          <div className="flex rounded-lg border border-slate-300 p-0.5" role="group" aria-label={t('View')}>
            {(['grid', 'list'] as const).map((v) => (
              <button
                key={v}
                onClick={() => setV(v)}
                aria-pressed={view === v}
                aria-label={t(v === 'grid' ? 'Grid view' : 'List view')}
                className={clsx('flex h-10 w-10 items-center justify-center rounded-md lg:h-8 lg:w-8', view === v ? 'bg-brand-50 text-brand-700' : 'text-slate-500')}
              >
                {v === 'grid' ? <LayoutGrid className="h-4 w-4" aria-hidden /> : <List className="h-4 w-4" aria-hidden />}
              </button>
            ))}
          </div>
        </div>
        <ErrorBox error={docs.error} />
        {docs.isLoading ? (
          <SkeletonList rows={4} />
        ) : !docs.data?.items.length ? (
          <Empty title={t(search || categoryId || source ? 'No matching documents' : 'No documents yet')} icon={FolderOpen}>
            {t('Files from approved task submissions appear here automatically.')}
          </Empty>
        ) : view === 'grid' ? (
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {docs.data.items.map((d) => (
              <li key={d.id} className="dt-fade-in flex min-w-0 flex-col rounded-xl border border-slate-200 p-4 transition-colors hover:border-brand-300">
                {isPreviewableImage(d.contentType) && (
                  <ImageThumb
                    source="document"
                    image={{ id: d.id, name: d.title, contentType: d.contentType, sizeBytes: d.sizeBytes }}
                    onOpen={() => setPreview(d)}
                    size="cover"
                    className="mb-3"
                  />
                )}
                <div className="flex items-start gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700">
                    <DocIcon doc={d} className="h-5 w-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="break-words font-medium text-slate-900">{d.title}</p>
                    <p className="truncate text-xs text-slate-500">
                      {d.fileName} · {formatBytes(d.sizeBytes)}
                    </p>
                  </div>
                </div>
                {d.description && <p className="mt-2 line-clamp-2 text-sm text-slate-600">{d.description}</p>}
                <div className="mt-3">{meta(d)}</div>
                <div className="mt-auto flex items-end justify-between gap-2 pt-3">
                  <p className="min-w-0 text-xs text-slate-500">
                    {d.uploadedBy.name} · {formatDate(d.createdAt)}
                    {d.task && (
                      <>
                        <br />
                        <Link href={`/tasks/${d.task.id}`} className="text-brand-700 hover:underline">
                          {d.task.title}
                        </Link>
                      </>
                    )}
                  </p>
                  {actions(d)}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="-mx-4 overflow-x-auto sm:-mx-5">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-start text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-4 py-2 text-start font-medium sm:px-5">{t('Document')}</th>
                  <th className="hidden px-3 py-2 text-start font-medium md:table-cell">{t('Category')}</th>
                  <th className="hidden px-3 py-2 text-start font-medium lg:table-cell">{t('Department')}</th>
                  <th className="hidden px-3 py-2 text-start font-medium md:table-cell">{t('Uploaded')}</th>
                  <th className="px-4 py-2 text-end font-medium sm:px-5">
                    <span className="sr-only">{t('Actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {docs.data.items.map((d) => (
                  <tr key={d.id} className="hover:bg-slate-50">
                    <td className="px-4 py-2.5 sm:px-5">
                      <div className="flex items-center gap-2">
                        {isPreviewableImage(d.contentType) ? (
                          <ImageThumb
                            source="document"
                            image={{ id: d.id, name: d.title, contentType: d.contentType, sizeBytes: d.sizeBytes }}
                            onOpen={() => setPreview(d)}
                            size="icon"
                          />
                        ) : (
                          <DocIcon doc={d} className="h-4 w-4 shrink-0 text-slate-400" />
                        )}
                        <div className="min-w-0">
                          <p className="break-words font-medium text-slate-900">{d.title}</p>
                          <p className="text-xs text-slate-500">
                            {d.fileName} · {formatBytes(d.sizeBytes)}
                          </p>
                          <div className="mt-1 md:hidden">{meta(d)}</div>
                        </div>
                      </div>
                    </td>
                    <td className="hidden px-3 py-2.5 md:table-cell">{meta(d)}</td>
                    <td className="hidden px-3 py-2.5 text-slate-600 lg:table-cell">{deptName(d.department, locale)}</td>
                    <td className="hidden px-3 py-2.5 text-slate-600 md:table-cell" title={formatDateTime(d.createdAt)}>
                      {d.uploadedBy.name}
                      <span className="block text-xs text-slate-400">{formatDate(d.createdAt)}</span>
                    </td>
                    <td className="px-4 py-2.5 sm:px-5">
                      <div className="flex justify-end">{actions(d)}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {pages > 1 && (
          <div className="mt-4 flex items-center justify-between text-sm">
            <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              {t('Previous')}
            </Button>
            <span className="text-slate-500">{t('Page {p} of {n}', { p: page, n: pages })}</span>
            <Button size="sm" variant="secondary" disabled={page >= pages} onClick={() => setPage(page + 1)}>
              {t('Next')}
            </Button>
          </div>
        )}
      </Card>
      {preview && <Preview doc={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}
