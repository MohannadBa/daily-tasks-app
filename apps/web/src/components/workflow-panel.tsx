'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftRight, CalendarClock, ClipboardCheck, Timer } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { TaskDetailDto } from '@dailytasks/shared-types';
import { api } from '@/lib/api';
import { formatDateTime, formatDuration } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { errorText, useFeedback } from './feedback';
import { useMe } from './providers';
import { Badge, Button, Card, Field, Input, Select, Textarea } from './ui';

function useRefresh(taskId: string) {
  const qc = useQueryClient();
  return async () => {
    await Promise.all(['task', 'comments', 'history'].map((k) => qc.invalidateQueries({ queryKey: [k, taskId] })));
    await qc.invalidateQueries({ queryKey: ['tasks'] });
    await qc.invalidateQueries({ queryKey: ['dashboard'] });
  };
}

function Section({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="space-y-3 border-t border-slate-100 pt-4 first:border-t-0 first:pt-0">
      <p className="flex items-center gap-2 text-sm font-semibold text-slate-800">
        <span className="text-slate-400">{icon}</span>
        {title}
      </p>
      {children}
    </div>
  );
}

/** Accountable time vs. budget (server-computed ledger; paused while awaiting manager review). */
export function TimeSummary({ task }: { task: TaskDetailDto }) {
  const { t } = useT();
  const tm = task.time;
  const pct = tm.budgetMs > 0 ? Math.min(100, Math.round((tm.accountableMs / tm.budgetMs) * 100)) : 0;
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
        <span className="text-slate-600">
          {t('Accountable time')}: <b className="text-slate-900">{formatDuration(tm.accountableMs)}</b> / {formatDuration(tm.budgetMs)}
        </span>
        {tm.paused && task.status !== 'COMPLETED' && <Badge tone="amber">{t('Clock paused')}</Badge>}
        {tm.overdue && <Badge tone="red">{t('Late by {d}', { d: formatDuration(tm.overdueMs) })}</Badge>}
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100" aria-hidden>
        <div className={tm.overdue ? 'h-full bg-danger-600' : 'h-full bg-brand-600'} style={{ width: `${pct}%` }} />
      </div>
      {task.originalDeadline !== task.deadline && (
        <p className="mt-2 text-xs text-slate-500">
          {t('Original deadline')}: {formatDateTime(task.originalDeadline)}
        </p>
      )}
    </div>
  );
}

function ReasonForm({ label, submitLabel, danger, onSubmit, optional }: { label: string; submitLabel: string; danger?: boolean; optional?: boolean; onSubmit: (reason: string) => Promise<unknown> }) {
  const { t } = useT();
  const [reason, setReason] = useState('');
  const [open, setOpen] = useState(false);
  const m = useMutation({ mutationFn: () => onSubmit(reason.trim()) });
  if (!open)
    return (
      <Button size="sm" variant={danger ? 'secondary' : 'secondary'} onClick={() => setOpen(true)}>
        {t(submitLabel)}
      </Button>
    );
  return (
    <form
      className="w-full space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (optional || reason.trim()) m.mutate();
      }}
    >
      <Textarea rows={2} required={!optional} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t(label)} aria-label={t(label)} />
      <div className="flex gap-2">
        <Button size="sm" type="submit" variant={danger ? 'danger' : 'primary'} loading={m.isPending} disabled={!optional && !reason.trim()}>
          {t(submitLabel)}
        </Button>
        <Button size="sm" type="button" variant="ghost" onClick={() => setOpen(false)}>
          {t('Cancel')}
        </Button>
      </div>
    </form>
  );
}

/**
 * Approval workflow, transfers and extension requests. Every button reflects a server-computed
 * permission; the API re-checks everything.
 */
export function WorkflowPanel({ task }: { task: TaskDetailDto }) {
  const { t } = useT();
  const me = useMe();
  const refresh = useRefresh(task.id);
  const { toast, confirm } = useFeedback();
  const p = task.permissions;
  // Latest decision on my work (shows the rejection / return reason so I can resume).
  const subs = useQuery({ queryKey: ['submissions', task.id, task.updatedAt], queryFn: () => api.tasks.submissions(task.id), enabled: task.assignee.id === me.id && task.status === 'IN_PROGRESS' });
  const sentBack = subs.data?.find((s) => s.submittedBy.id === me.id && s.status !== 'PENDING');
  const showSentBack = sentBack && (sentBack.status === 'REJECTED' || sentBack.status === 'RETURNED') && task.status === 'IN_PROGRESS';
  const sub = task.pendingSubmission;
  const tr = task.pendingTransfer;
  const ext = task.pendingExtension;
  const run = (fn: () => Promise<unknown>, ok: string) => async () => {
    try {
      await fn();
      toast(t(ok));
      await refresh();
    } catch (e) {
      toast(errorText(e), 'error');
      throw e;
    }
  };
  const [adminReason, setAdminReason] = useState('');
  const needsAdminReason = me.role === 'ADMIN' && task.approver.id !== me.id;

  const [toUserId, setToUserId] = useState('');
  const [transferReason, setTransferReason] = useState('');
  const candidates = useQuery({ queryKey: ['transfer-candidates', task.id], queryFn: () => api.tasks.transferCandidates(task.id), enabled: p.canTransfer });
  const [hours, setHours] = useState('24');
  const [extReason, setExtReason] = useState('');
  const [granted, setGranted] = useState('');

  const transfer = useMutation({ mutationFn: run(() => api.tasks.requestTransfer(task.id, { toUserId, reason: transferReason.trim() }), 'Transfer requested') });
  const extension = useMutation({ mutationFn: run(() => api.tasks.requestExtension(task.id, { requestedMinutes: Math.round(Number(hours) * 60), reason: extReason.trim() }), 'Extension requested') });

  const anything = sub || tr || ext || p.canTransfer || p.canRequestExtension;
  return (
    <Card title={<span className="inline-flex items-center gap-2"><Timer className="h-4 w-4" aria-hidden /> {t('Workflow')}</span>}>
      <div className="space-y-4">
        <TimeSummary task={task} />

        {showSentBack && (
          <div role="status" className="dt-fade-in rounded-lg border border-danger-200 bg-danger-50 p-3 text-sm text-danger-700">
            <p className="font-medium">{t(sentBack.status === 'REJECTED' ? 'Your submission was rejected by {name}' : 'Your work was returned by {name}', { name: sentBack.decidedBy?.name ?? '' })}</p>
            {sentBack.decisionReason && <p className="mt-1 whitespace-pre-wrap break-words">{sentBack.decisionReason}</p>}
            <p className="mt-1 text-xs">{t('Continue working and submit again when ready.')}</p>
          </div>
        )}

        {sub && (
          <Section icon={<ClipboardCheck className="h-4 w-4" />} title={sub.stage === 'DELEGATOR' ? t('Awaiting review by {name}', { name: sub.reviewer.name }) : t('Awaiting approval by {name}', { name: sub.reviewer.name })}>
            <p className="text-xs text-slate-500">
              {t('Submitted by {name}', { name: sub.submittedBy.name })} · {formatDateTime(sub.createdAt)}
            </p>
            <p className="whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-sm text-slate-700">{sub.comment.body}</p>
            {p.canApprove && (
              <div className="flex flex-wrap gap-2">
                {needsAdminReason && (
                  <Input value={adminReason} onChange={(e) => setAdminReason(e.target.value)} placeholder={t('Reason for deciding instead of the approver')} aria-label={t('Reason for deciding instead of the approver')} />
                )}
                <Button size="sm" onClick={() => void run(() => api.submissions.approve(sub.id, needsAdminReason ? { adminReason } : {}), 'Task approved')().catch(() => {})} disabled={needsAdminReason && !adminReason.trim()}>
                  {t('Approve')}
                </Button>
                <ReasonForm label="Why is it rejected? (required)" submitLabel="Reject" danger onSubmit={(reason) => run(() => api.submissions.reject(sub.id, { reason, ...(needsAdminReason ? { adminReason } : {}) }), 'Submission rejected')()} />
              </div>
            )}
            {p.canReviewAsDelegator && (
              <div className="flex flex-wrap gap-2">
                <ReasonForm label="Note for the approver (optional)" submitLabel="Forward for approval" optional onSubmit={(note) => run(() => api.submissions.forward(sub.id, note ? { note } : {}), 'Forwarded for approval')()} />
                <ReasonForm label="What needs to change? (required)" submitLabel="Return to colleague" danger onSubmit={(reason) => run(() => api.submissions.returnToDelegate(sub.id, reason), 'Returned')()} />
              </div>
            )}
            {p.canWithdraw && (
              <Button size="sm" variant="ghost" onClick={() => void run(() => api.submissions.withdraw(sub.id), 'Submission withdrawn')().catch(() => {})}>
                {t('Withdraw submission')}
              </Button>
            )}
          </Section>
        )}

        {tr && (
          <Section icon={<ArrowLeftRight className="h-4 w-4" />} title={t('Transfer from {from} to {to}', { from: tr.from.name, to: tr.to.name })}>
            <p className="whitespace-pre-wrap text-sm text-slate-700">{tr.reason}</p>
            <div className="flex flex-wrap gap-2">
              {p.canRespondTransfer && (
                <>
                  <Button size="sm" onClick={() => void run(() => api.transfers.accept(tr.id), 'Transfer accepted')().catch(() => {})}>
                    {t('Accept')}
                  </Button>
                  <ReasonForm label="Why can't you take it? (required)" submitLabel="Decline" danger onSubmit={(reason) => run(() => api.transfers.decline(tr.id, reason), 'Transfer declined')()} />
                </>
              )}
              {p.canCancelTransfer && (
                <Button size="sm" variant="ghost" onClick={() => void run(() => api.transfers.cancel(tr.id), 'Transfer cancelled')().catch(() => {})}>
                  {t('Cancel transfer')}
                </Button>
              )}
            </div>
          </Section>
        )}

        {ext && (
          <Section icon={<CalendarClock className="h-4 w-4" />} title={t('Extension requested: {d}', { d: formatDuration(ext.requestedMinutes * 60_000) })}>
            <p className="whitespace-pre-wrap text-sm text-slate-700">{ext.reason}</p>
            {p.canDecideExtension && (
              <div className="flex flex-wrap items-end gap-2">
                <Button size="sm" onClick={() => void run(() => api.extensions.decide(ext.id, { decision: 'APPROVE' }), 'Extension approved')().catch(() => {})}>
                  {t('Approve')}
                </Button>
                <Field label={t('Grant hours')}>
                  <Input type="number" min={0.25} step={0.25} value={granted} onChange={(e) => setGranted(e.target.value)} className="w-24" />
                </Field>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!granted || Number(granted) * 60 >= ext.requestedMinutes}
                  onClick={() => void run(() => api.extensions.decide(ext.id, { decision: 'PARTIAL', grantedMinutes: Math.round(Number(granted) * 60) }), 'Extension partially approved')().catch(() => {})}
                >
                  {t('Approve partially')}
                </Button>
                <ReasonForm label="Why is it rejected? (required)" submitLabel="Reject" danger onSubmit={(note) => run(() => api.extensions.decide(ext.id, { decision: 'REJECT', note }), 'Extension rejected')()} />
              </div>
            )}
            {p.canCancelExtension && (
              <Button size="sm" variant="ghost" onClick={() => void run(() => api.extensions.cancel(ext.id), 'Request cancelled')().catch(() => {})}>
                {t('Cancel request')}
              </Button>
            )}
          </Section>
        )}

        {p.canTransfer && (
          <Section icon={<ArrowLeftRight className="h-4 w-4" />} title={t('Transfer to a colleague')}>
            <form
              className="space-y-2"
              onSubmit={async (e) => {
                e.preventDefault();
                const to = candidates.data?.find((u) => u.id === toUserId)?.name ?? '';
                const ok = await confirm({
                  title: t('Transfer this task to {name}?', { name: to }),
                  message: t('You stay responsible until they accept. The deadline does not change and the transfer is recorded in the task history.'),
                  confirmLabel: t('Request transfer'),
                });
                if (ok) transfer.mutate();
              }}
            >
              <Select required value={toUserId} onChange={(e) => setToUserId(e.target.value)} aria-label={t('Colleague')}>
                <option value="">{t('Select a colleague…')}</option>
                {candidates.data?.length === 0 && <option disabled>{t('No eligible colleagues in this project and department')}</option>}
              {(candidates.data ?? []).map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </Select>
              <Textarea rows={2} required maxLength={2000} value={transferReason} onChange={(e) => setTransferReason(e.target.value)} placeholder={t('Reason (required)')} aria-label={t('Reason (required)')} />
              <Button size="sm" type="submit" loading={transfer.isPending} disabled={!toUserId || !transferReason.trim()}>
                {t('Request transfer')}
              </Button>
            </form>
          </Section>
        )}

        {p.canRequestExtension && (
          <Section icon={<CalendarClock className="h-4 w-4" />} title={t('Request more time')}>
            <form
              className="space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                extension.mutate();
              }}
            >
              <Field label={t('Extra hours')}>
                <Input type="number" min={0.25} max={720} step={0.25} required value={hours} onChange={(e) => setHours(e.target.value)} className="w-28" />
              </Field>
              <Textarea rows={2} required maxLength={2000} value={extReason} onChange={(e) => setExtReason(e.target.value)} placeholder={t('Reason (required)')} aria-label={t('Reason (required)')} />
              <Button size="sm" type="submit" variant="secondary" loading={extension.isPending} disabled={!extReason.trim() || !(Number(hours) > 0)}>
                {t('Request extension')}
              </Button>
            </form>
          </Section>
        )}
        {!anything && task.status === 'COMPLETED' && <p className="text-sm text-slate-500">{t('Approved and completed.')}</p>}
      </div>
    </Card>
  );
}
