'use client';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import type { TaskView } from '@dailytasks/shared-types';
import { useIsManager } from '@/components/providers';
import { TaskTable } from '@/components/task-table';
import { PRIORITIES, priorityLabel } from '@/components/task-form';
import { Button, Card, ErrorBox, Input, LinkButton, PageHeader, Select, SkeletonList, Spinner, Tabs } from '@/components/ui';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';

function TasksInner() {
  const router = useRouter();
  const params = useSearchParams();
  const isManager = useIsManager();
  const { t, locale } = useT();
  const view = (params.get('view') as TaskView) || 'all';
  const projectId = params.get('projectId') ?? '';
  const sort = params.get('sort') ?? '';
  const departmentId = params.get('departmentId') ?? '';
  const priority = params.get('priority') ?? '';
  const page = Number(params.get('page') ?? 1);
  const [q, setQ] = useState(params.get('q') ?? '');

  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api.projects.list() });
  const departments = useQuery({ queryKey: ['departments'], queryFn: () => api.departments.list() });
  const tasks = useQuery({
    queryKey: ['tasks', view, projectId, departmentId, priority, params.get('q'), sort, page],
    queryFn: () =>
      api.tasks.list({
        view,
        projectId: projectId || undefined,
        departmentId: departmentId || undefined,
        priority: priority || undefined,
        q: params.get('q') || undefined,
        sort: sort || undefined,
        page,
        pageSize: 25,
      }),
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
    { value: 'to_review', label: t('To review') },
    { value: 'pending_review', label: t('Pending approval') },
    ...(!isManager ? [{ value: 'rejected' as TaskView, label: t('Sent back to me') }] : []),
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
          className="mb-4 grid grid-cols-[1fr_auto] gap-2 sm:flex sm:flex-wrap sm:gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            setParam({ q: q.trim() || undefined });
          }}
        >
          <Input type="search" enterKeyHint="search" className="sm:max-w-xs" placeholder={t('Search tasks…')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('Search tasks…')} />
          <Select className="order-last col-span-2 sm:order-none sm:col-span-1 sm:max-w-xs" value={projectId} onChange={(e) => setParam({ projectId: e.target.value || undefined })} aria-label={t('Filter by project')}>
            <option value="">{t('All projects')}</option>
            {projects.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
          <Select className="order-last col-span-2 sm:order-none sm:col-span-1 sm:max-w-[13rem]" value={departmentId} onChange={(e) => setParam({ departmentId: e.target.value || undefined })} aria-label={t('Filter by department')}>
            <option value="">{t('All departments')}</option>
            {departments.data?.map((d) => (
              <option key={d.id} value={d.id}>
                {locale === 'ar' ? d.nameAr : d.nameEn}
              </option>
            ))}
          </Select>
          <Select className="order-last col-span-2 sm:order-none sm:col-span-1 sm:max-w-[10rem]" value={priority} onChange={(e) => setParam({ priority: e.target.value || undefined })} aria-label={t('Filter by priority')}>
            <option value="">{t('All priorities')}</option>
            {PRIORITIES.map((pr) => (
              <option key={pr} value={pr}>
                {t(priorityLabel[pr])}
              </option>
            ))}
          </Select>
          <Select className="order-last col-span-2 sm:order-none sm:col-span-1 sm:max-w-[13rem]" value={sort} onChange={(e) => setParam({ sort: e.target.value || undefined })} aria-label={t('Sort by')}>
            <option value="">{t('Sort: default')}</option>
            <option value="deadline">{t('Deadline: soonest first')}</option>
            <option value="-deadline">{t('Deadline: latest first')}</option>
            <option value="-created">{t('Newest first')}</option>
            <option value="-updated">{t('Recently updated')}</option>
            <option value="title">{t('Title A–Z')}</option>
          </Select>
          <Button type="submit" variant="secondary">
            {t('Search')}
          </Button>
        </form>
        <ErrorBox error={tasks.error} />
        {tasks.isLoading ? <SkeletonList rows={6} /> : tasks.data && <TaskTable tasks={tasks.data.items} />}
        {tasks.data && tasks.data.total > tasks.data.pageSize && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-slate-500">
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
