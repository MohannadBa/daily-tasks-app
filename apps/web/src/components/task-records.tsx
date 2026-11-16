'use client';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowLeftRight, CalendarClock, ChevronLeft, ClipboardCheck, Clock } from 'lucide-react';
import type { TaskDetailDto } from '@dailytasks/shared-types';
import { api } from '@/lib/api';
import { formatDateTime, formatDuration } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { extensionStatus, segmentLabel, submissionStatus, transferStatus } from '@/lib/labels';
import { ImageGallery, isPreviewableImage } from './image-preview';
import { Badge, Card, Empty, SkeletonList } from './ui';

function Row({ label, value, tone }: { label: string; value: string; tone?: 'danger' | 'muted' }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5 text-sm">
      <dt className="text-slate-600">{label}</dt>
      <dd className={clsx('tabular-nums font-medium', tone === 'danger' ? 'text-danger-700' : tone === 'muted' ? 'text-slate-500' : 'text-slate-900')}>{value}</dd>
    </div>
  );
}

/**
 * Authoritative time accounting from GET /tasks/:id/time. Every number is computed by the server;
 * the client only formats it.
 */
export function TimeAccounting({ task }: { task: TaskDetailDto }) {
  const { t } = useT();
  const q = useQuery({ queryKey: ['task-time', task.id, task.updatedAt], queryFn: () => api.tasks.time(task.id) });
  return (
    <Card title={<span className="inline-flex items-center gap-2"><Clock className="h-4 w-4" aria-hidden /> {t('Time accounting')}</span>}>
      {q.isLoading ? (
        <SkeletonList rows={3} />
      ) : !q.data?.cycles.length ? (
        <Empty title={t('No time recorded yet')} />
      ) : (
        <div className="space-y-5">
          {[...q.data.cycles].reverse().map((c) => (
            <section key={c.cycleNo} className="dt-fade-in">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <p className="text-sm font-semibold text-slate-800">{t('Cycle {n}', { n: c.cycleNo })}</p>
                {c.provisional && <Badge tone="amber">{t('Provisional — awaiting manager decision')}</Badge>}
                {c.completedAt && <Badge tone={c.completedLate ? 'amber' : 'green'}>{t(c.completedLate ? 'Final — completed late' : 'Final — completed on time')}</Badge>}
                {!c.completedAt && !c.provisional && c.overdue && <Badge tone="red">{t('Overdue')}</Badge>}
              </div>
              <dl className="divide-y divide-slate-100">
                <Row label={t('Original deadline')} value={formatDateTime(c.originalDeadline)} />
                <Row label={t('Approved deadline')} value={formatDateTime(c.approvedDeadline)} />
                <Row label={t('Time allowed')} value={formatDuration(c.budgetMs)} />
                <Row label={t('Accountable time')} value={formatDuration(c.accountableMs)} />
                <Row label={t(c.completedAt ? 'Late by' : c.provisional ? 'Over budget (provisional)' : 'Overdue by')} value={c.overdueMs > 0 ? formatDuration(c.overdueMs) : '—'} tone={c.overdueMs > 0 ? 'danger' : 'muted'} />
                <Row label={t(segmentLabel.ACTIVE_WORK)} value={formatDuration(c.totals.activeWorkMs)} />
                {c.totals.transferPendingMs > 0 && <Row label={t(segmentLabel.TRANSFER_PENDING)} value={formatDuration(c.totals.transferPendingMs)} />}
                {c.totals.delegatorReviewMs > 0 && <Row label={t(segmentLabel.DELEGATOR_REVIEW)} value={formatDuration(c.totals.delegatorReviewMs)} />}
                {c.totals.pendingReviewMs > 0 && <Row label={t(segmentLabel.PENDING_REVIEW)} value={formatDuration(c.totals.pendingReviewMs)} tone="muted" />}
                <Row label={t(segmentLabel.APPROVED_REVIEW)} value={formatDuration(c.totals.approvedReviewMs)} tone="muted" />
                <Row label={t(segmentLabel.REJECTED_REVIEW)} value={formatDuration(c.totals.rejectedReviewMs)} tone={c.totals.rejectedReviewMs > 0 ? 'danger' : 'muted'} />
                {c.totals.completionMs !== null && <Row label={t('Completion duration')} value={formatDuration(c.totals.completionMs)} />}
              </dl>
              {c.perEmployee.length > 0 && (
                <div className="mt-3">
                  <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">{t('Time by responsible employee')}</p>
                  <ul className="space-y-1">
                    {c.perEmployee.map((p) => (
                      <li key={p.user.id} className="flex items-center justify-between gap-2 text-sm">
                        <span className="truncate text-slate-700">{p.user.name}</span>
                        <span className="shrink-0 tabular-nums text-slate-900">
                          {formatDuration(p.chargedMs)}
                          {p.lateMs > 0 && <span className="ms-2 text-xs text-danger-700">({t('late {d}', { d: formatDuration(p.lateMs) })})</span>}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          ))}
        </div>
      )}
    </Card>
  );
}

/** All submissions and decisions (newest first), including rejection reasons. */
export function SubmissionHistory({ task }: { task: TaskDetailDto }) {
  const { t } = useT();
  const q = useQuery({ queryKey: ['submissions', task.id, task.updatedAt], queryFn: () => api.tasks.submissions(task.id) });
  if (!q.data?.length) return null;
  return (
    <Card title={<span className="inline-flex items-center gap-2"><ClipboardCheck className="h-4 w-4" aria-hidden /> {t('Submissions & decisions')}</span>}>
      <ol className="space-y-3">
        {q.data.map((s) => {
          const st = submissionStatus[s.status];
          return (
            <li key={s.id} className="rounded-lg border border-slate-200 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium text-slate-900">{s.submittedBy.name}</span>
                <span className="flex items-center gap-2">
                  <Badge tone={st.tone}>{t(st.label)}</Badge>
                  <span className="text-xs text-slate-400">{formatDateTime(s.createdAt)}</span>
                </span>
              </div>
              <p className="mt-1 text-xs text-slate-500">
                {t(s.stage === 'DELEGATOR' ? 'Reviewed by colleague {name}' : 'Reviewed by approver {name}', { name: s.reviewer.name })} · {t('Cycle {n}', { n: s.cycleNo })}
              </p>
              <p className="mt-2 whitespace-pre-wrap break-words text-sm text-slate-700">{s.comment.body}</p>
              <ImageGallery
                source="attachment"
                className="mt-2"
                images={s.comment.attachments.filter((a) => isPreviewableImage(a.contentType)).map((a) => ({ id: a.id, name: a.fileName, contentType: a.contentType, sizeBytes: a.sizeBytes }))}
              />
              {s.comment.attachments.some((a) => !isPreviewableImage(a.contentType)) && (
                <p className="mt-1 text-xs text-slate-500">{t('{n} attachment(s)', { n: s.comment.attachments.filter((a) => !isPreviewableImage(a.contentType)).length })}</p>
              )}
              {s.decidedBy && (
                <div className={clsx('mt-2 rounded-md px-3 py-2 text-sm', s.status === 'REJECTED' || s.status === 'RETURNED' ? 'bg-danger-50 text-danger-700' : 'bg-slate-50 text-slate-700')}>
                  <span className="font-medium">{s.decidedBy.name}</span> · {formatDateTime(s.decidedAt)}
                  {s.decidedAsAdmin && <Badge tone="amber">{t('Admin decision')}</Badge>}
                  {s.decisionReason && <p className="mt-1 whitespace-pre-wrap break-words">{s.decisionReason}</p>}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

/** Delegation chain + every transfer request. */
export function TransferHistory({ task }: { task: TaskDetailDto }) {
  const { t } = useT();
  const q = useQuery({ queryKey: ['transfers', task.id, task.updatedAt], queryFn: () => api.tasks.transfers(task.id) });
  if (!q.data?.length) return null;
  const chain = q.data.filter((x) => x.status === 'ACCEPTED' && !x.closedAt && x.cycleNo === task.currentCycle).sort((a, b) => a.depth - b.depth);
  return (
    <Card title={<span className="inline-flex items-center gap-2"><ArrowLeftRight className="h-4 w-4" aria-hidden /> {t('Transfers')}</span>}>
      {chain.length > 0 && (
        <div className="mb-4">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">{t('Current delegation chain')}</p>
          <ol className="flex flex-wrap items-center gap-1.5 text-sm" aria-label={t('Current delegation chain')}>
            <li className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-700">{task.approver.name}</li>
            {[chain[0]!.from, ...chain.map((c) => c.to)].map((u, i) => (
              <li key={`${u.id}-${i}`} className="flex items-center gap-1.5">
                <ChevronLeft className="h-4 w-4 text-slate-300 ltr:rotate-180" aria-hidden />
                <span className={clsx('rounded-full px-2.5 py-1', u.id === task.assignee.id ? 'bg-brand-50 font-medium text-brand-700' : 'bg-slate-100 text-slate-700')}>{u.name}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
      <ol className="space-y-2">
        {q.data.map((x) => (
          <li key={x.id} className="rounded-lg border border-slate-200 p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium text-slate-900">
                {x.from.name} → {x.to.name}
              </span>
              <Badge tone={transferStatus[x.status].tone}>{t(transferStatus[x.status].label)}</Badge>
            </div>
            <p className="mt-1 whitespace-pre-wrap break-words text-slate-700">{x.reason}</p>
            <p className="mt-1 text-xs text-slate-500">
              {formatDateTime(x.requestedAt)}
              {x.respondedAt && <> · {t('responded {date}', { date: formatDateTime(x.respondedAt) })}</>}
              {x.responseNote && <> · {x.responseNote}</>}
            </p>
          </li>
        ))}
      </ol>
    </Card>
  );
}

/** Extension requests: original deadline, requested, granted, decision. */
export function ExtensionHistory({ task }: { task: TaskDetailDto }) {
  const { t } = useT();
  const q = useQuery({ queryKey: ['extensions', task.id, task.updatedAt], queryFn: () => api.tasks.extensions(task.id) });
  if (!q.data?.length) return null;
  return (
    <Card title={<span className="inline-flex items-center gap-2"><CalendarClock className="h-4 w-4" aria-hidden /> {t('Deadline extensions')}</span>}>
      <p className="mb-3 text-xs text-slate-500">
        {t('Original deadline')}: <span className="font-medium text-slate-700">{formatDateTime(task.originalDeadline)}</span> · {t('Approved deadline')}:{' '}
        <span className="font-medium text-slate-700">{formatDateTime(task.deadline)}</span>
      </p>
      <ol className="space-y-2">
        {q.data.map((x) => (
          <li key={x.id} className="rounded-lg border border-slate-200 p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium text-slate-900">
                {x.requestedBy.name} · {t('requested {d}', { d: formatDuration(x.requestedMinutes * 60_000) })}
              </span>
              <Badge tone={extensionStatus[x.status].tone}>{t(extensionStatus[x.status].label)}</Badge>
            </div>
            <p className="mt-1 whitespace-pre-wrap break-words text-slate-700">{x.reason}</p>
            <p className="mt-1 text-xs text-slate-500">
              {formatDateTime(x.createdAt)}
              {x.grantedMinutes ? <> · {t('granted {d}', { d: formatDuration(x.grantedMinutes * 60_000) })}</> : null}
              {x.newDeadline && <> · {formatDateTime(x.previousDeadline)} → {formatDateTime(x.newDeadline)}</>}
              {x.decidedBy && <> · {x.decidedBy.name}</>}
            </p>
            {x.decisionNote && <p className="mt-1 text-xs text-slate-600">{x.decisionNote}</p>}
          </li>
        ))}
      </ol>
    </Card>
  );
}
