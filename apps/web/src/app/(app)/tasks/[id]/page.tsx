'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Calendar, CheckCircle2, Download, FileText, History, Pencil, RotateCcw, UserRound } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import type { AttachmentDto, TaskDetailDto, TaskHistoryDto } from '@dailytasks/shared-types';
import { errorText, useFeedback } from '@/components/feedback';
import { FilePicker } from '@/components/file-picker';
import { StarInput, Stars } from '@/components/stars';
import { StatusBadge } from '@/components/task-table';
import { priorityLabel } from '@/components/task-form';
import { WorkflowPanel } from '@/components/workflow-panel';
import { ImageGallery, isPreviewableImage } from '@/components/image-preview';
import { ExtensionHistory, SubmissionHistory, TimeAccounting, TransferHistory } from '@/components/task-records';
import { useMe } from '@/components/providers';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Select, Spinner, Textarea } from '@/components/ui';
import { api } from '@/lib/api';
import { openAttachment, uploadFiles } from '@/lib/files';
import { formatBytes, formatDateTime, formatRelative, isoToLocalInput, localInputToIso } from '@/lib/format';
import { historyLabel } from '@/lib/history';
import { useT } from '@/lib/i18n';

function AttachmentList({ items }: { items: AttachmentDto[] }) {
  if (items.length === 0) return null;
  // Images are previewed in place (thumbnail + in-app viewer); other files stay download chips.
  const images = items.filter((a) => isPreviewableImage(a.contentType));
  const files = items.filter((a) => !isPreviewableImage(a.contentType));
  return (
    <>
      <ImageGallery source="attachment" className="mt-2" images={images.map((a) => ({ id: a.id, name: a.fileName, contentType: a.contentType, sizeBytes: a.sizeBytes }))} />
      {files.length > 0 && <FileChips items={files} />}
    </>
  );
}

function FileChips({ items }: { items: AttachmentDto[] }) {
  return (
    <ul className="mt-2 grid gap-2 sm:flex sm:flex-wrap">
      {items.map((a) => (
        <li key={a.id} className="min-w-0">
          <button
            onClick={() => void openAttachment(a.id)}
            className="flex min-h-11 w-full items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-start text-sm text-slate-700 hover:border-brand-500 hover:text-brand-700 active:bg-slate-50 sm:inline-flex sm:min-h-0 sm:w-auto sm:py-1.5"
          >
            <FileText className="h-4 w-4 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 truncate sm:max-w-[16rem]">{a.fileName}</span>
            <span className="shrink-0 text-xs text-slate-400">{formatBytes(a.sizeBytes)}</span>
            <Download className="h-4 w-4 shrink-0 sm:h-3.5 sm:w-3.5" aria-hidden />
          </button>
        </li>
      ))}
    </ul>
  );
}

function Meta({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-start gap-3">
      <span className="mt-0.5 text-slate-400">{icon}</span>
      <div className="min-w-0 break-words">
        <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
        <div className="text-sm text-slate-900">{children}</div>
      </div>
    </div>
  );
}


function HistoryList({ items }: { items: TaskHistoryDto[] }) {
  const { t } = useT();
  return (
    <ol className="space-y-3">
      {[...items].reverse().map((h) => (
        <li key={h.id} className="text-sm">
          <span className="font-medium text-slate-800">{h.actor?.name ?? t('System')}</span> <span className="text-slate-600">{t(historyLabel[h.action] ?? h.action)}</span>
          {h.action === 'REOPENED' && typeof h.metadata.reason === 'string' && <p className="mt-0.5 text-slate-500">“{h.metadata.reason}”</p>}
          {h.action === 'COMPLETED' && h.metadata.completedLate === true && (
            <span className="ms-1">
              <Badge tone="amber">{t('late')}</Badge>
            </span>
          )}
          <p className="text-xs text-slate-400">{formatDateTime(h.createdAt)}</p>
        </li>
      ))}
    </ol>
  );
}

function RatingPanel({ task }: { task: TaskDetailDto }) {
  const { toast } = useFeedback();
  const qc = useQueryClient();
  const { t } = useT();
  const rating = useQuery({ queryKey: ['rating', task.id], queryFn: () => api.tasks.getRating(task.id) });
  const [stars, setStars] = useState(0);
  const [feedback, setFeedback] = useState('');
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (rating.data) {
      setStars(rating.data.stars);
      setFeedback(rating.data.feedback ?? '');
    }
  }, [rating.data]);
  const save = useMutation({
    mutationFn: () => api.tasks.rate(task.id, { stars, feedback: feedback.trim() || null }),
    onSuccess: async () => {
      toast(t('Rating saved'));
      setEditing(false);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['rating', task.id] }),
        qc.invalidateQueries({ queryKey: ['task', task.id] }),
        qc.invalidateQueries({ queryKey: ['tasks'] }),
        qc.invalidateQueries({ queryKey: ['dashboard'] }),
        qc.invalidateQueries({ queryKey: ['performance'] }),
      ]);
    },
  });
  if (rating.isLoading) return <Spinner />;
  const existing = rating.data;
  const showForm = !existing || editing;
  return (
    <Card title={t('Performance rating')} actions={<span className="text-xs text-slate-400">{t('Private · not visible to the employee')}</span>}>
      <ErrorBox error={save.error} />
      {!showForm && existing ? (
        <div className="space-y-2">
          <Stars value={existing.stars} size={22} />
          {task.rating?.needsReview && <Badge tone="amber">{t('Task was completed again after this rating — review it')}</Badge>}
          {existing.feedback && <p className="whitespace-pre-wrap text-sm text-slate-700">{existing.feedback}</p>}
          <p className="text-xs text-slate-400">
            {t('Rated by {name} · {date}', { name: existing.ratedBy.name, date: formatDateTime(existing.updatedAt) })}
          </p>
          <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
            {t('Edit rating')}
          </Button>
        </div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (stars >= 1) save.mutate();
          }}
        >
          <StarInput value={stars} onChange={setStars} />
          <Field label={t('Private feedback (optional)')}>
            <Textarea rows={3} maxLength={4000} value={feedback} onChange={(e) => setFeedback(e.target.value)} />
          </Field>
          <div className="flex gap-2">
            <Button type="submit" loading={save.isPending} disabled={stars < 1}>
              {t(existing ? 'Update rating' : 'Save rating')}
            </Button>
            {editing && (
              <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
                {t('Cancel')}
              </Button>
            )}
          </div>
        </form>
      )}
    </Card>
  );
}

function StartButton({ taskId }: { taskId: string }) {
  const qc = useQueryClient();
  const { t } = useT();
  const { toast } = useFeedback();
  const start = useMutation({
    mutationFn: () => api.tasks.start(taskId),
    onSuccess: async () => {
      toast(t('Work started'));
      await Promise.all(['task', 'history'].map((k) => qc.invalidateQueries({ queryKey: [k, taskId] })));
      await qc.invalidateQueries({ queryKey: ['tasks'] });
    },
    onError: (e) => toast(errorText(e), 'error'),
  });
  return (
    <Button size="sm" onClick={() => start.mutate()} loading={start.isPending}>
      {t('Start task')}
    </Button>
  );
}

function ManagerActions({ task }: { task: TaskDetailDto }) {
  const qc = useQueryClient();
  const { t } = useT();
  const [mode, setMode] = useState<'none' | 'reopen' | 'reassign' | 'approver'>('none');
  const me = useMe();
  const [approverId, setApproverId] = useState('');
  // Approver candidates: managers of this project + company admins.
  const managers = useQuery({ queryKey: ['members', task.projectId], queryFn: () => api.projects.members(task.projectId), enabled: mode === 'approver' });
  const admins = useQuery({ queryKey: ['users', 'ADMIN'], queryFn: () => api.users.list({ role: 'ADMIN' }), enabled: mode === 'approver' && me.role === 'ADMIN' });
  const approverOptions = [
    ...(managers.data ?? []).filter((m) => m.role === 'MANAGER').map((m) => ({ id: m.userId, name: m.name })),
    ...(admins.data ?? []).filter((u) => u.isActive).map((u) => ({ id: u.id, name: u.name })),
  ].filter((o, i, all) => o.id !== task.approver.id && all.findIndex((x) => x.id === o.id) === i);
  const changeApprover = useMutation({
    mutationFn: () => api.tasks.changeApprover(task.id, approverId),
    onSuccess: () => {
      setMode('none');
      toast(t('Approver changed'));
      return refresh();
    },
  });
  const [reason, setReason] = useState('');
  const [deadline, setDeadline] = useState(isoToLocalInput(new Date(Math.max(Date.now() + 86400_000, new Date(task.deadline).getTime())).toISOString()));
  const [assigneeId, setAssigneeId] = useState('');
  // Reassignment candidates: employees of the project AND the task's department (server-filtered).
  const eligible = useQuery({
    queryKey: ['assignable', task.department?.id, task.projectId],
    queryFn: () => api.departments.assignableEmployees(task.department!.id, task.projectId),
    enabled: mode === 'reassign' && !!task.department,
  });
  const members = useQuery({ queryKey: ['members', task.projectId], queryFn: () => api.projects.members(task.projectId), enabled: mode === 'reassign' && !task.department });
  const reassignOptions = task.department
    ? (eligible.data ?? []).filter((u) => u.id !== task.assignee.id).map((u) => ({ id: u.id, name: u.name }))
    : (members.data ?? []).filter((m) => m.role === 'EMPLOYEE' && m.userId !== task.assignee.id).map((m) => ({ id: m.userId, name: m.name }));
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['task', task.id] }), qc.invalidateQueries({ queryKey: ['history', task.id] }), qc.invalidateQueries({ queryKey: ['tasks'] })]);
  const { toast } = useFeedback();
  const reopen = useMutation({ mutationFn: () => api.tasks.reopen(task.id, { reason, deadline: localInputToIso(deadline) }), onSuccess: () => { setMode('none'); toast(t('Task reopened')); return refresh(); } });
  const reassign = useMutation({ mutationFn: () => api.tasks.reassign(task.id, assigneeId), onSuccess: () => { setMode('none'); toast(t('Task reassigned')); return refresh(); } });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {task.permissions.canEdit && (
          <Link href={`/tasks/${task.id}/edit`} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50">
            <Pencil className="h-4 w-4" aria-hidden /> {t('Edit')}
          </Link>
        )}
        {task.permissions.canReassign && (
          <Button size="sm" variant="secondary" onClick={() => setMode(mode === 'reassign' ? 'none' : 'reassign')}>
            <UserRound className="h-4 w-4" aria-hidden /> {t('Reassign')}
          </Button>
        )}
        {task.permissions.canChangeApprover && task.status !== 'COMPLETED' && (
          <Button size="sm" variant="secondary" onClick={() => setMode(mode === 'approver' ? 'none' : 'approver')}>
            <UserRound className="h-4 w-4" aria-hidden /> {t('Change approver')}
          </Button>
        )}
        {task.permissions.canReopen && (
          <Button size="sm" variant="secondary" onClick={() => setMode(mode === 'reopen' ? 'none' : 'reopen')}>
            <RotateCcw className="h-4 w-4" aria-hidden /> {t('Reopen')}
          </Button>
        )}
      </div>
      {mode === 'reopen' && (
        <form className="space-y-3 rounded-lg bg-slate-50 p-4" onSubmit={(e) => { e.preventDefault(); reopen.mutate(); }}>
          <ErrorBox error={reopen.error} />
          <Field label={t('Reason (recorded in history and sent to the employee)')}>
            <Textarea rows={2} required value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <Field label={t('New deadline')}>
            <Input type="datetime-local" required value={deadline} onChange={(e) => setDeadline(e.target.value)} className="sm:max-w-xs" />
          </Field>
          <Button size="sm" type="submit" loading={reopen.isPending}>{t('Reopen task')}</Button>
        </form>
      )}
      {mode === 'approver' && (
        <form className="grid gap-3 rounded-lg bg-slate-50 p-4 sm:flex sm:flex-wrap sm:items-end" onSubmit={(e) => { e.preventDefault(); changeApprover.mutate(); }}>
          <ErrorBox error={changeApprover.error} />
          <Field label={t('New approver')}>
            <Select required value={approverId} onChange={(e) => setApproverId(e.target.value)}>
              <option value="">{t('Select…')}</option>
              {approverOptions.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </Select>
          </Field>
          <Button size="sm" type="submit" loading={changeApprover.isPending} disabled={!approverId}>{t('Save')}</Button>
        </form>
      )}
      {mode === 'reassign' && (
        <form className="grid gap-3 rounded-lg bg-slate-50 p-4 sm:flex sm:flex-wrap sm:items-end" onSubmit={(e) => { e.preventDefault(); reassign.mutate(); }}>
          <ErrorBox error={reassign.error} />
          <Field label={t('New assignee')}>
            <Select required value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
              <option value="">{t('Select…')}</option>
              {reassignOptions.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </Select>
          </Field>
          <Button size="sm" type="submit" loading={reassign.isPending}>{t('Reassign')}</Button>
        </form>
      )}
    </div>
  );
}

function ReplyBox({ task, completion }: { task: TaskDetailDto; completion: boolean }) {
  const qc = useQueryClient();
  const { t } = useT();
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [progress, setProgress] = useState<number[] | undefined>();
  const { toast } = useFeedback();
  const send = useMutation({
    mutationFn: async () => {
      setProgress(files.length ? files.map(() => 0) : undefined);
      const uploaded = files.length ? await uploadFiles(task.id, files, (i, f) => setProgress((p) => p?.map((v, j) => (j === i ? f : v)))) : [];
      const attachmentIds = uploaded.map((a) => a.id);
      // Completion is a submission for approval; only the approver can complete the task.
      if (completion) await api.tasks.submit(task.id, { comment: body.trim(), attachmentIds });
      else await api.tasks.addComment(task.id, { body: body.trim(), attachmentIds });
    },
    onSuccess: async () => {
      setBody('');
      setFiles([]);
      toast(t(completion ? 'Submitted for approval' : 'Reply sent'));
      await Promise.all(['task', 'comments', 'history'].map((k) => qc.invalidateQueries({ queryKey: [k, task.id] })));
      await qc.invalidateQueries({ queryKey: ['tasks'] });
      await qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (e) => toast(errorText(e), 'error'),
    onSettled: () => setProgress(undefined),
  });
  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (body.trim()) send.mutate(); }}>
      <ErrorBox error={send.error} />
      <Textarea
        rows={3}
        required
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={t(completion ? 'Describe the completed work (required)…' : 'Write a reply…')}
        aria-label={t(completion ? 'Completion comment' : 'Reply')}
      />
      <FilePicker files={files} onChange={setFiles} onError={setFileError} progress={progress} disabled={send.isPending} />
      {fileError && <p className="text-xs text-danger-600">{fileError}</p>}
      <div className="flex justify-end">
        <Button type="submit" loading={send.isPending} disabled={!body.trim()} className="w-full sm:w-auto">
          {completion ? (<><CheckCircle2 className="h-4 w-4" aria-hidden /> {t('Submit for approval')}</>) : t('Send reply')}
        </Button>
      </div>
    </form>
  );
}

export default function TaskDetailPage() {
  const { id } = useParams<{ id: string }>();
  const task = useQuery({ queryKey: ['task', id], queryFn: () => api.tasks.get(id) });
  const comments = useQuery({ queryKey: ['comments', id], queryFn: () => api.tasks.comments(id), enabled: !!task.data });
  const history = useQuery({ queryKey: ['history', id], queryFn: () => api.tasks.history(id), enabled: !!task.data });
  const [completing, setCompleting] = useState(false);
  const { t, locale } = useT();

  if (task.isLoading) return <Spinner />;
  if (task.error || !task.data) return <ErrorBox error={task.error ?? t('Task not found')} />;
  const td = task.data;
  const isManagerView = td.permissions.canEdit || td.permissions.canReopen;

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Link href={`/projects/${td.projectId}`} className="text-sm text-brand-700 hover:underline">{td.projectName}</Link>
          <h1 className="mt-1 break-words text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl">{td.title}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <StatusBadge task={td} />
            {td.reopenCount > 0 && <Badge>{t('Reopened ×{n}', { n: td.reopenCount })}</Badge>}
            <Badge tone={td.priority === 'URGENT' ? 'red' : td.priority === 'HIGH' ? 'amber' : 'gray'}>{t(priorityLabel[td.priority])}</Badge>
            {td.department && <Badge tone="blue">{locale === 'ar' ? td.department.nameAr : td.department.nameEn}</Badge>}
          </div>
        </div>
        <div className="flex flex-wrap items-start gap-2">
          {td.permissions.canStart && <StartButton taskId={td.id} />}
          {isManagerView && <ManagerActions task={td} />}
        </div>
      </div>

      <div className="grid gap-4 sm:gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-4 sm:space-y-6 lg:col-span-2">
          <Card title={t('Details')}>
            <div className="mb-5 grid grid-cols-2 gap-4 sm:grid-cols-3">
              <Meta icon={<UserRound className="h-4 w-4" />} label={t('Assignee')}>{td.assignee.name}</Meta>
              <Meta icon={<UserRound className="h-4 w-4" />} label={t('Approver')}>{td.approver.name}</Meta>
              <Meta icon={<UserRound className="h-4 w-4" />} label={t('Assigned by')}>{td.createdBy.name}</Meta>
              <Meta icon={<Calendar className="h-4 w-4" />} label={t('Deadline')}>
                {formatDateTime(td.deadline)}
                {td.status !== 'COMPLETED' && <span className={td.isOverdue ? 'block text-xs text-red-600' : 'block text-xs text-slate-500'}>{formatRelative(td.deadline)}</span>}
              </Meta>
              <Meta icon={<CheckCircle2 className="h-4 w-4" />} label={t('Completed')}>
                {td.completedAt ? formatDateTime(td.completedAt) : '—'}
                {td.completedLate && <span className="block text-xs text-warning-700">{t('after the deadline')}</span>}
              </Meta>
            </div>
            {td.description ? <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-700">{td.description}</p> : <p className="text-sm text-slate-400">{t('No description')}</p>}
            {td.attachments.length > 0 && (
              <div className="mt-4">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{t('Instructions & reference files')}</p>
                <AttachmentList items={td.attachments} />
              </div>
            )}
          </Card>

          <SubmissionHistory task={td} />
          <TransferHistory task={td} />
          <ExtensionHistory task={td} />
          <Card title={t('Replies ({n})', { n: comments.data?.length ?? 0 })}>
            {comments.isLoading ? (
              <Spinner />
            ) : comments.data && comments.data.length > 0 ? (
              <ul className="space-y-4">
                {comments.data.map((c) => (
                  <li key={c.id} className={c.isCompletionNote ? 'rounded-lg border border-success-200 bg-success-50 p-3 sm:p-4' : 'rounded-lg bg-slate-50 p-3 sm:p-4'}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm font-medium text-slate-900">{c.author.name}</span>
                      <span className="text-xs text-slate-400">{formatDateTime(c.createdAt)}</span>
                    </div>
                    {c.isCompletionNote && <Badge tone="green">{t('Completion report')}</Badge>}
                    <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-700">{c.body}</p>
                    <AttachmentList items={c.attachments} />
                  </li>
                ))}
              </ul>
            ) : (
              <Empty title={t('No replies yet')} />
            )}
            {td.permissions.canComment && (
              <div className="mt-6 border-t border-slate-100 pt-4">
                {td.permissions.canComplete && (
                  <div className="mb-3 grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1 sm:inline-grid" role="tablist" aria-label={t('Reply or complete')}>
                    {[false, true].map((c) => (
                      <button
                        key={String(c)}
                        type="button"
                        role="tab"
                        aria-selected={completing === c}
                        onClick={() => setCompleting(c)}
                        className={clsx('min-h-10 rounded-md px-4 text-sm font-medium transition', completing === c ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500')}
                      >
                        {t(c ? 'Submit completion' : 'Reply')}
                      </button>
                    ))}
                  </div>
                )}
                <ReplyBox task={td} completion={completing && td.permissions.canComplete} />
              </div>
            )}
          </Card>
        </div>

        <div className="min-w-0 space-y-4 sm:space-y-6">
          <WorkflowPanel task={td} />
          <TimeAccounting task={td} />
          {td.permissions.canRate && <RatingPanel task={td} />}
          <Card title={<span className="inline-flex items-center gap-2"><History className="h-4 w-4" aria-hidden /> {t('History')}</span>}>
            {history.data ? <HistoryList items={history.data} /> : <Spinner />}
          </Card>
        </div>
      </div>
    </div>
  );
}
