'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftRight } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import type { TransferDto } from '@dailytasks/shared-types';
import { errorText, useFeedback } from '@/components/feedback';
import { Button, Card, Empty, ErrorBox, PageHeader, SkeletonList, Textarea } from '@/components/ui';
import { api } from '@/lib/api';
import { formatDateTime, formatRelative } from '@/lib/format';
import { useT } from '@/lib/i18n';

function TransferCard({ tr, onDone }: { tr: TransferDto; onDone: () => Promise<unknown> }) {
  const taskId = tr.task.id;
  const { t } = useT();
  const { toast } = useFeedback();
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const act = useMutation({
    mutationFn: (accept: boolean) => (accept ? api.transfers.accept(tr.id) : api.transfers.decline(tr.id, reason.trim())),
    onSuccess: async (_r, accept) => {
      toast(t(accept ? 'Transfer accepted' : 'Transfer declined'));
      await onDone();
    },
    onError: (e) => toast(errorText(e), 'error'),
  });
  return (
    <li className="dt-fade-in">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <p className="text-sm text-slate-700">
            <span className="font-semibold text-slate-900">{tr.from.name}</span> {t('wants to transfer a task to you')}
          </p>
          <p className="w-full text-sm">
            <Link href={`/tasks/${taskId}`} className="font-medium text-brand-700 hover:underline">{tr.task.title}</Link>
            <span className="text-slate-500"> · {tr.task.projectName}</span>
          </p>
          <span className="text-xs text-slate-400" title={formatDateTime(tr.requestedAt)}>
            {formatRelative(tr.requestedAt)}
          </span>
        </div>
        <p className="mt-2 whitespace-pre-wrap break-words rounded-lg bg-slate-50 p-3 text-sm text-slate-800">{tr.reason}</p>
        {declining ? (
          <form
            className="mt-3 space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (reason.trim()) act.mutate(false);
            }}
          >
            <Textarea rows={2} required maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("Why can't you take it? (required)")} aria-label={t('Reason')} autoFocus />
            <div className="flex gap-2">
              <Button type="submit" variant="danger" loading={act.isPending} disabled={!reason.trim()}>
                {t('Decline')}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setDeclining(false)}>
                {t('Cancel')}
              </Button>
            </div>
          </form>
        ) : (
          <div className="mt-3 flex flex-wrap gap-2">
            <Button onClick={() => act.mutate(true)} loading={act.isPending}>
              {t('Accept')}
            </Button>
            <Button variant="secondary" onClick={() => setDeclining(true)}>
              {t('Decline')}
            </Button>
            <Link href={`/tasks/${taskId}`} className="inline-flex min-h-11 items-center px-3 text-sm font-medium text-brand-700 lg:min-h-0">
              {t('Open task')}
            </Link>
          </div>
        )}
      </Card>
    </li>
  );
}

export default function TransfersPage() {
  const { t } = useT();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['transfers', 'incoming'], queryFn: () => api.transfers.incoming() });
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['transfers'] });
    await qc.invalidateQueries({ queryKey: ['tasks'] });
    await qc.invalidateQueries({ queryKey: ['dashboard'] });
  };
  return (
    <>
      <PageHeader title={t('Incoming transfers')} subtitle={t('Colleagues asking you to take over a task. You become responsible only after you accept.')} />
      <ErrorBox error={q.error} />
      {q.isLoading ? (
        <Card>
          <SkeletonList rows={3} />
        </Card>
      ) : !q.data?.length ? (
        <Empty title={t('No incoming transfers')} icon={ArrowLeftRight} />
      ) : (
        <ul className="space-y-4">
          {q.data.map((tr) => (
            <TransferCard key={tr.id} tr={tr} onDone={refresh} />
          ))}
        </ul>
      )}
    </>
  );
}
