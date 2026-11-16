'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ClipboardCheck, FileText, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import type { ReviewItemDto } from '@dailytasks/shared-types';
import { errorText, useFeedback } from '@/components/feedback';
import { ImageGallery, isPreviewableImage } from '@/components/image-preview';
import { useMe } from '@/components/providers';
import { StatusBadge } from '@/components/task-table';
import { Badge, Button, Card, Empty, ErrorBox, Input, PageHeader, SkeletonList, Textarea } from '@/components/ui';
import { api } from '@/lib/api';
import { openAttachment } from '@/lib/files';
import { formatDateTime, formatDuration, formatRelative } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { deptName, priorityTone } from '@/lib/labels';
import { priorityLabel } from '@/components/task-form';

function ReviewCard({ item, onDone }: { item: ReviewItemDto; onDone: () => Promise<unknown> }) {
  const { t, locale } = useT();
  const me = useMe();
  const { toast } = useFeedback();
  const { submission: s, task } = item;
  const [mode, setMode] = useState<'none' | 'reject' | 'return'>('none');
  const [reason, setReason] = useState('');
  const [adminReason, setAdminReason] = useState('');
  const delegator = s.stage === 'DELEGATOR';
  const breakGlass = !delegator && me.role === 'ADMIN' && task.approver.id !== me.id;
  const extra = breakGlass ? { adminReason: adminReason.trim() } : {};
  const act = useMutation({
    mutationFn: async (kind: 'approve' | 'reject' | 'forward' | 'return') => {
      if (kind === 'approve') return api.submissions.approve(s.id, extra);
      if (kind === 'reject') return api.submissions.reject(s.id, { reason: reason.trim(), ...extra });
      if (kind === 'forward') return api.submissions.forward(s.id);
      return api.submissions.returnToDelegate(s.id, reason.trim());
    },
    onSuccess: async (_r, kind) => {
      toast(t({ approve: 'Task approved', reject: 'Submission rejected', forward: 'Forwarded for approval', return: 'Returned' }[kind]));
      await onDone();
    },
    onError: (e) => toast(errorText(e), 'error'),
  });
  const time = task.time;
  return (
    <li className="dt-fade-in">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <Link href={`/tasks/${task.id}`} className="break-words text-base font-semibold text-slate-900 hover:text-brand-700">
              {task.title}
            </Link>
            <p className="mt-0.5 text-sm text-slate-500">
              {task.projectName} · {deptName(task.department, locale)}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={priorityTone[task.priority]}>{t(priorityLabel[task.priority])}</Badge>
            <StatusBadge task={task} />
            {delegator && <Badge tone="blue">{t('Delegated work')}</Badge>}
          </div>
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-slate-500">{t('Employee')}</dt>
            <dd className="font-medium text-slate-900">{s.submittedBy.name}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">{t('Submitted')}</dt>
            <dd className="text-slate-900">{formatDateTime(s.createdAt)}</dd>
            <dd className="text-xs text-slate-400">{formatRelative(s.createdAt)}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">{t('Accountable time')}</dt>
            <dd className="tabular-nums text-slate-900">
              {formatDuration(time.accountableMs)} / {formatDuration(time.budgetMs)}
            </dd>
            {time.overdue && <dd className="text-xs text-danger-700">{t('Over budget by {d} (provisional)', { d: formatDuration(time.overdueMs) })}</dd>}
          </div>
          <div>
            <dt className="text-xs text-slate-500">{t('Deadline')}</dt>
            <dd className="text-slate-900">{formatDateTime(task.deadline)}</dd>
            {task.originalDeadline !== task.deadline && <dd className="text-xs text-slate-400">{t('Original: {d}', { d: formatDateTime(task.originalDeadline) })}</dd>}
          </div>
        </dl>

        <div className="mt-4 rounded-lg bg-slate-50 p-3">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{t('Completion comment')}</p>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-800">{s.comment.body}</p>
          <ImageGallery
            source="attachment"
            className="mt-2"
            images={s.comment.attachments.filter((a) => isPreviewableImage(a.contentType)).map((a) => ({ id: a.id, name: a.fileName, contentType: a.contentType, sizeBytes: a.sizeBytes }))}
          />
          {s.comment.attachments.some((a) => !isPreviewableImage(a.contentType)) && (
            <ul className="mt-2 flex flex-wrap gap-2">
              {s.comment.attachments.filter((a) => !isPreviewableImage(a.contentType)).map((a) => (
                <li key={a.id}>
                  <button onClick={() => void openAttachment(a.id)} className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700 hover:border-brand-500">
                    <FileText className="h-4 w-4" aria-hidden /> {a.fileName}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {breakGlass && (
          <div className="mt-3">
            <Input value={adminReason} onChange={(e) => setAdminReason(e.target.value)} placeholder={t('Reason for deciding instead of the approver')} aria-label={t('Reason for deciding instead of the approver')} />
            <p className="mt-1 text-xs text-slate-500">{t('Approver: {name}. Your decision is audited and the approver is notified.', { name: task.approver.name })}</p>
          </div>
        )}

        {mode !== 'none' ? (
          <form
            className="mt-3 space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (reason.trim()) act.mutate(mode === 'reject' ? 'reject' : 'return');
            }}
          >
            <Textarea rows={3} required maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t(mode === 'reject' ? 'Why is it rejected? (required)' : 'What needs to change? (required)')} aria-label={t('Reason')} autoFocus />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="danger" loading={act.isPending} disabled={!reason.trim() || (breakGlass && !adminReason.trim())}>
                {t(mode === 'reject' ? 'Reject' : 'Return to colleague')}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setMode('none')}>
                {t('Cancel')}
              </Button>
            </div>
          </form>
        ) : (
          <div className="mt-4 flex flex-wrap gap-2">
            {delegator ? (
              <>
                <Button onClick={() => act.mutate('forward')} loading={act.isPending}>
                  <CheckCircle2 className="h-4 w-4" aria-hidden /> {t('Forward for approval')}
                </Button>
                <Button variant="secondary" onClick={() => setMode('return')}>
                  <XCircle className="h-4 w-4" aria-hidden /> {t('Return to colleague')}
                </Button>
              </>
            ) : (
              <>
                <Button onClick={() => act.mutate('approve')} loading={act.isPending} disabled={breakGlass && !adminReason.trim()}>
                  <CheckCircle2 className="h-4 w-4" aria-hidden /> {t('Approve')}
                </Button>
                <Button variant="secondary" onClick={() => setMode('reject')}>
                  <XCircle className="h-4 w-4" aria-hidden /> {t('Reject')}
                </Button>
              </>
            )}
            <Link href={`/tasks/${task.id}`} className="inline-flex min-h-11 items-center px-3 text-sm font-medium text-brand-700 lg:min-h-0">
              {t('Open task')}
            </Link>
          </div>
        )}
      </Card>
    </li>
  );
}

export default function ReviewsPage() {
  const { t } = useT();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['reviews', false], queryFn: () => api.reviews.inbox() });
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['reviews'] });
    await qc.invalidateQueries({ queryKey: ['tasks'] });
    await qc.invalidateQueries({ queryKey: ['dashboard'] });
  };
  return (
    <>
      <PageHeader
        title={t('Review inbox')}
        subtitle={t('Completion submissions waiting for your decision. Only an approval completes a task.')}
      />
      <ErrorBox error={q.error} />
      {q.isLoading ? (
        <Card>
          <SkeletonList rows={4} />
        </Card>
      ) : !q.data?.length ? (
        <Empty title={t('Nothing to review')} icon={ClipboardCheck}>
          {t('New submissions appear here instantly.')}
        </Empty>
      ) : (
        <ul className="space-y-4">
          {q.data.map((item) => (
            <ReviewCard key={item.submission.id} item={item} onDone={refresh} />
          ))}
        </ul>
      )}
    </>
  );
}
