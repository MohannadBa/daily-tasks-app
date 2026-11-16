'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, Card, Empty, ErrorBox, LinkButton, PageHeader, Spinner, Tabs } from '@/components/ui';
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
      <PageHeader title={t('Notifications')} actions={
          <>
            <LinkButton href="/settings/notifications" variant="secondary">
              {t('Notification settings')}
            </LinkButton>
            <Button size="sm" variant="secondary" onClick={() => readAll.mutate()} loading={readAll.isPending}>
              {t('Mark all as read')}
            </Button>
          </>
        } />
      <Tabs value={filter} onChange={setFilter} items={[{ value: 'all', label: t('All') }, { value: 'unread', label: t('Unread') }]} />
      <Card>
        <ErrorBox error={list.error} />
        {list.isLoading ? (
          <Spinner />
        ) : !list.data?.items.length ? (
          <Empty title={t("You're all caught up")} />
        ) : (
          <ul className="-mx-4 divide-y divide-slate-100 sm:-mx-5">
            {list.data.items.map((n) => (
              <li key={n.id}>
                <button onClick={() => open.mutate(n)} className={clsx('flex w-full items-start gap-3 px-4 py-3.5 text-start hover:bg-slate-50 active:bg-slate-100 sm:px-5 sm:py-3', !n.readAt && 'bg-brand-50/50')}>
                  <span className={clsx('mt-1.5 h-2 w-2 shrink-0 rounded-full', n.readAt ? 'bg-transparent' : 'bg-brand-600')} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-start justify-between gap-2">
                      <span className="min-w-0 break-words text-sm font-medium text-slate-900">{n.title}</span>
                      <span className="shrink-0 whitespace-nowrap text-xs text-slate-400">{formatRelative(n.createdAt)}</span>
                    </span>
                    <span className="block break-words text-sm text-slate-600">{n.body}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
