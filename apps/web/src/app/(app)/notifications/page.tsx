'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, Card, Empty, ErrorBox, PageHeader, Spinner, Tabs } from '@/components/ui';
import { api } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { useT } from '@/lib/i18n';

export default function NotificationsPage() {
  const qc = useQueryClient();
  const router = useRouter();
  const { t } = useT();
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const list = useQuery({
    queryKey: ['notifications', 'list', filter],
    queryFn: () => api.notifications.list({ unreadOnly: filter === 'unread', pageSize: 50 }),
    refetchInterval: 30_000,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['notifications'] });
  const readAll = useMutation({ mutationFn: () => api.notifications.markAllRead(), onSuccess: refresh });
  const open = useMutation({
    mutationFn: async (n: { id: string; taskId: string | null; readAt: string | null }) => {
      if (!n.readAt) await api.notifications.markRead(n.id);
      return n;
    },
    onSuccess: async (n) => {
      await refresh();
      if (n.taskId) router.push(`/tasks/${n.taskId}`);
    },
  });

  return (
    <>
      <PageHeader title={t('Notifications')} actions={<Button variant="secondary" onClick={() => readAll.mutate()} loading={readAll.isPending}>{t('Mark all as read')}</Button>} />
      <Tabs value={filter} onChange={setFilter} items={[{ value: 'all', label: t('All') }, { value: 'unread', label: t('Unread') }]} />
      <Card>
        <ErrorBox error={list.error} />
        {list.isLoading ? (
          <Spinner />
        ) : !list.data?.items.length ? (
          <Empty title={t("You're all caught up")} />
        ) : (
          <ul className="-mx-5 divide-y divide-slate-100">
            {list.data.items.map((n) => (
              <li key={n.id}>
                <button onClick={() => open.mutate(n)} className={clsx('flex w-full items-start gap-3 px-5 py-3 text-start hover:bg-slate-50', !n.readAt && 'bg-brand-50/50')}>
                  <span className={clsx('mt-1.5 h-2 w-2 shrink-0 rounded-full', n.readAt ? 'bg-transparent' : 'bg-brand-600')} aria-hidden />
                  <span className="flex-1">
                    <span className="block text-sm font-medium text-slate-900">{n.title}</span>
                    <span className="block text-sm text-slate-600">{n.body}</span>
                  </span>
                  <span className="whitespace-nowrap text-xs text-slate-400">{formatRelative(n.createdAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
