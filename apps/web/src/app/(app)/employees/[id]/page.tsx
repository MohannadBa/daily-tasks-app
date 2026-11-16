'use client';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, type ReactNode } from 'react';
import { Stars } from '@/components/stars';
import { TaskTable } from '@/components/task-table';
import { Badge, Card, Empty, ErrorBox, PageHeader, SkeletonList, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useT } from '@/lib/i18n';

function Kpi({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <div className="mt-2 text-xl font-semibold text-slate-900 sm:text-2xl">{children}</div>
    </div>
  );
}

function EmployeeDetail() {
  const { id } = useParams<{ id: string }>();
  const projectId = useSearchParams().get('projectId') ?? undefined;
  const { t } = useT();
  const q = useQuery({ queryKey: ['performance', 'employee', id, projectId], queryFn: () => api.performance.employee(id, projectId) });
  const tasks = useQuery({ queryKey: ['tasks', 'assignee', id, projectId], queryFn: () => api.tasks.list({ assigneeId: id, projectId, view: 'active', pageSize: 50 }) });
  if (q.isLoading) return <Spinner />;
  if (!q.data) return <ErrorBox error={q.error ?? t('Not found')} />;
  const d = q.data;
  return (
    <>
      <PageHeader title={d.employee.name} subtitle={<>{d.employee.email} · {t('ratings are private and never shown to the employee')}</>} />
      <div className="mb-4 grid grid-cols-2 gap-3 sm:mb-6 sm:gap-4 lg:grid-cols-5">
        <Kpi label={t('Average rating')}>
          <span className="flex items-center gap-2">
            {d.averageRating?.toFixed(2) ?? '—'}
            <Stars value={d.averageRating} size={16} />
          </span>
        </Kpi>
        <Kpi label={t('Rated tasks')}>{d.ratedTaskCount}</Kpi>
        <Kpi label={t('Completed')}>{d.completedTaskCount}</Kpi>
        <Kpi label={t('Open')}>{d.openTaskCount}</Kpi>
        <Kpi label={t('Overdue')}>{d.overdueTaskCount}</Kpi>
      </div>
      <div className="mb-4 grid gap-4 sm:mb-6 sm:gap-6 lg:grid-cols-3">
        <Card title={t('Open tasks ({n})', { n: tasks.data?.total ?? 0 })} className="lg:col-span-2">
          {tasks.isLoading ? <SkeletonList rows={3} /> : <TaskTable tasks={tasks.data?.items ?? []} emptyText="No open tasks" />}
        </Card>
        <Card title={t('Projects')}>
          {d.projects.length === 0 ? (
            <Empty title={t('No projects')} />
          ) : (
            <ul className="-my-1 divide-y divide-slate-100">
              {d.projects.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-2 py-2.5">
                  <Link href={`/projects/${p.id}`} className="min-w-0 truncate text-sm font-medium text-slate-900 hover:text-brand-700">{p.name}</Link>
                  {p.removed ? <Badge>{t('Removed')}</Badge> : <Badge tone="blue">{t(p.role === 'MANAGER' ? 'Manager' : 'Member')}</Badge>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <div className="grid gap-4 sm:gap-6 lg:grid-cols-3">
        <Card title={t('Task ratings')} className="lg:col-span-2">
          {d.ratings.length === 0 ? (
            <Empty title={t('No rated tasks yet')} />
          ) : (
            <ul className="divide-y divide-slate-100">
              {d.ratings.map((r) => (
                <li key={r.taskId} className="py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Link href={`/tasks/${r.taskId}`} className="font-medium text-slate-900 hover:text-brand-700">{r.taskTitle}</Link>
                    <Stars value={r.stars} size={14} />
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    <span>{r.projectName}</span>·<span>{t('completed {date}', { date: formatDateTime(r.completedAt) })}</span>
                    {r.completedLate && <Badge tone="amber">{t('late')}</Badge>}·<span>{t('rated by {name}', { name: r.ratedBy.name })}</span>
                  </div>
                  {r.feedback && <p className="mt-1.5 whitespace-pre-wrap text-sm text-slate-600">{r.feedback}</p>}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title={t('Rating history')}>
          {d.history.length === 0 ? (
            <Empty title={t('No changes')} />
          ) : (
            <ol className="space-y-3">
              {d.history.map((h) => (
                <li key={h.id} className="text-sm">
                  <p className="text-slate-800">
                    <span className="font-medium">{h.changedBy.name}</span> {t(h.previousStars === null ? 'rated' : 'changed rating of')}{' '}
                    <Link href={`/tasks/${h.taskId}`} className="text-brand-700 hover:underline">{h.taskTitle}</Link>
                  </p>
                  <p className="text-slate-600">{h.previousStars !== null && <>{h.previousStars}★ → </>}{h.newStars}★</p>
                  <p className="text-xs text-slate-400">{formatDateTime(h.createdAt)}</p>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>
    </>
  );
}

export default function EmployeeDetailPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <EmployeeDetail />
    </Suspense>
  );
}
