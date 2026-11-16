'use client';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import type { TaskView } from '@dailytasks/shared-types';
import { useIsManager } from '@/components/providers';
import { TaskTable } from '@/components/task-table';
import { Button, Card, ErrorBox, Input, LinkButton, PageHeader, Select, Spinner, Tabs } from '@/components/ui';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';

function TasksInner() {
  const router = useRouter();
  const params = useSearchParams();
  const isManager = useIsManager();
  const { t } = useT();
  const view = (params.get('view') as TaskView) || 'all';
  const projectId = params.get('projectId') ?? '';
  const page = Number(params.get('page') ?? 1);
  const [q, setQ] = useState(params.get('q') ?? '');

  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api.projects.list() });
  const tasks = useQuery({
    queryKey: ['tasks', view, projectId, params.get('q'), page],
    queryFn: () => api.tasks.list({ view, projectId: projectId || undefined, q: params.get('q') || undefined, page, pageSize: 25 }),
    placeholderData: keepPreviousData,
  });

  const setParam = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    if (!('page' in patch)) next.delete('page');
    router.replace(`/tasks?${next.toString()}`);
  };

  const tabs: Array<{ value: TaskView; label: string }> = [
    { value: 'all', label: t('All') },
    { value: 'active', label: t('Active') },
    { value: 'overdue', label: t('Overdue') },
    { value: 'completed', label: t('Completed') },
    ...(isManager ? [{ value: 'awaiting_rating' as TaskView, label: t('Awaiting rating') }] : []),
  ];
  const totalPages = tasks.data ? Math.max(1, Math.ceil(tasks.data.total / tasks.data.pageSize)) : 1;

  return (
    <>
      <PageHeader title={t(isManager ? 'Tasks' : 'My tasks')} actions={isManager && <LinkButton href="/tasks/new">{t('New task')}</LinkButton>} />
      <Tabs value={view} onChange={(v) => setParam({ view: v === 'all' ? undefined : v })} items={tabs} />
      <Card>
        <form
          className="mb-4 flex flex-wrap gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            setParam({ q: q.trim() || undefined });
          }}
        >
          <Input className="max-w-xs" placeholder={t('Search tasks…')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('Search tasks…')} />
          <Select className="max-w-xs" value={projectId} onChange={(e) => setParam({ projectId: e.target.value || undefined })} aria-label="Filter by project">
            <option value="">{t('All projects')}</option>
            {projects.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
          <Button type="submit" variant="secondary">
            {t('Search')}
          </Button>
        </form>
        <ErrorBox error={tasks.error} />
        {tasks.isLoading ? <Spinner /> : tasks.data && <TaskTable tasks={tasks.data.items} />}
        {tasks.data && tasks.data.total > tasks.data.pageSize && (
          <div className="mt-4 flex items-center justify-between text-sm text-slate-500">
            <span>
              {t('{total} tasks · page {page} of {pages}', { total: tasks.data.total, page, pages: totalPages })}
            </span>
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setParam({ page: String(page - 1) })}>
                {t('Previous')}
              </Button>
              <Button size="sm" variant="secondary" disabled={page >= totalPages} onClick={() => setParam({ page: String(page + 1) })}>
                {t('Next')}
              </Button>
            </div>
          </div>
        )}
      </Card>
    </>
  );
}

export default function TasksPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <TasksInner />
    </Suspense>
  );
}
