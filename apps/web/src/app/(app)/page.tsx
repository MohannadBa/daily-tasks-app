'use client';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Activity, AlarmClock, AlertTriangle, ArrowLeftRight, Building2, CheckCircle2, ClipboardCheck, ClipboardList, FolderKanban, Hourglass, Inbox, Lock, NotebookPen, PlayCircle, Star, Undo2, Users } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import type { ActivityDto } from '@dailytasks/shared-types';
import { useIsManager, useMe } from '@/components/providers';
import { Stars } from '@/components/stars';
import { TaskTable } from '@/components/task-table';
import { Card, Empty, ErrorBox, LinkButton, PageHeader, Skeleton, SkeletonList } from '@/components/ui';
import { api } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { historyLabel } from '@/lib/history';
import { useT } from '@/lib/i18n';

function Stat({ label, value, icon, href, tone, emphasise }: { label: string; value: number; icon: ReactNode; href: string; tone: string; emphasise?: boolean }) {
  return (
    <Link
      href={href}
      className={clsx(
        'group min-w-0 rounded-[var(--radius-card)] border bg-white p-4 transition-colors hover:border-brand-300 active:bg-brand-50 sm:p-5',
        emphasise ? 'border-danger-200' : 'border-slate-200',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="line-clamp-2 min-w-0 text-sm font-medium leading-snug text-slate-600">{label}</span>
        <span className={`rounded-lg p-2 ${tone}`}>{icon}</span>
      </div>
      <p className="mt-2 text-2xl font-semibold tabular-nums text-slate-900 sm:mt-3 sm:text-3xl">{value}</p>
    </Link>
  );
}

function StatsSkeleton({ n }: { n: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 xl:grid-cols-4">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="rounded-[var(--radius-card)] border border-slate-200 bg-white p-4 sm:p-5">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="mt-4 h-7 w-12" />
        </div>
      ))}
    </div>
  );
}

function ActivityFeed({ items }: { items: ActivityDto[] }) {
  const { t } = useT();
  if (items.length === 0) return <Empty title={t('No activity yet')} icon={Activity} />;
  return (
    <ol className="-my-1 divide-y divide-slate-100">
      {items.map((a) => (
        <li key={a.id} className="py-2.5">
          <Link href={`/tasks/${a.taskId}`} className="block rounded-md hover:bg-slate-50">
            <p className="text-sm text-slate-700">
              <span className="font-medium text-slate-900">{a.actorName ?? t('System')}</span> {t(historyLabel[a.action] ?? a.action)}
            </p>
            <p className="truncate text-xs text-slate-500">
              {a.taskTitle} · {a.projectName} · {formatRelative(a.createdAt)}
            </p>
          </Link>
        </li>
      ))}
    </ol>
  );
}

export default function DashboardPage() {
  const me = useMe();
  const isManager = useIsManager();
  const { t } = useT();
  const { data, error, isLoading } = useQuery({ queryKey: ['dashboard'], queryFn: () => api.dashboard.get() });
  // Personal workspace stats are separate (own endpoint, owner-only) and never mixed with company KPIs.
  const personal = useQuery({ queryKey: ['personal', 'OPEN', '', 1], queryFn: () => api.personalTasks.list({ status: 'OPEN', page: 1, pageSize: 25 }) });
  const isAdmin = me.role === 'ADMIN';

  return (
    <>
      <PageHeader
        title={t('Welcome, {name}', { name: me.name.split(' ')[0] })}
        subtitle={t(isManager ? 'Overview of your projects and team' : 'Your tasks at a glance')}
        actions={isManager && <LinkButton href="/tasks/new">{t('New task')}</LinkButton>}
      />
      <ErrorBox error={error} />
      {isLoading || !data ? (
        <div className="space-y-4 sm:space-y-6">
          <StatsSkeleton n={8} />
          <Card title={t('Upcoming deadlines')}>
            <SkeletonList rows={4} />
          </Card>
        </div>
      ) : (
        <div className="space-y-4 sm:space-y-6">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 xl:grid-cols-4">
            {isAdmin ? (
              <>
                <Stat label={t('Employees')} value={data.totals.employees ?? 0} href="/users" icon={<Users className="h-4 w-4" />} tone="bg-brand-50 text-brand-700" />
                <Stat label={t('Departments')} value={data.totals.departments ?? 0} href="/departments" icon={<Building2 className="h-4 w-4" />} tone="bg-brand-50 text-brand-700" />
                <Stat label={t('Projects')} value={data.totals.projects} href="/projects" icon={<FolderKanban className="h-4 w-4" />} tone="bg-info-50 text-info-700" />
                <Stat label={t('Assigned tasks')} value={data.totals.activeTasks} href="/tasks?view=active" icon={<ClipboardList className="h-4 w-4" />} tone="bg-info-50 text-info-700" />
              </>
            ) : isManager ? (
              <>
                <Stat label={t('Managed projects')} value={data.totals.projects} href="/projects" icon={<FolderKanban className="h-4 w-4" />} tone="bg-brand-50 text-brand-700" />
                <Stat label={t('Assigned tasks')} value={data.totals.activeTasks} href="/tasks?view=active" icon={<ClipboardList className="h-4 w-4" />} tone="bg-info-50 text-info-700" />
              </>
            ) : (
              <>
                <Stat label={t('Assigned to me')} value={data.totals.activeTasks} href="/tasks?view=active" icon={<ClipboardList className="h-4 w-4" />} tone="bg-info-50 text-info-700" />
                <Stat label={t('In progress')} value={data.totals.inProgressTasks} href="/tasks?view=active" icon={<PlayCircle className="h-4 w-4" />} tone="bg-info-50 text-info-700" />
              </>
            )}
            {isManager && (
              <Stat label={t('Waiting for my review')} value={data.totals.toReview} href="/reviews" icon={<ClipboardCheck className="h-4 w-4" />} tone="bg-warning-50 text-warning-700" emphasise={data.totals.toReview > 0} />
            )}
            <Stat label={t('Pending approval')} value={data.totals.pendingReviewTasks} href="/tasks?view=pending_review" icon={<Hourglass className="h-4 w-4" />} tone="bg-warning-50 text-warning-700" />
            {!isManager && (
              <Stat label={t('Sent back to me')} value={data.totals.rejectedSubmissions} href="/tasks?view=rejected" icon={<Undo2 className="h-4 w-4" />} tone="bg-danger-50 text-danger-700" emphasise={data.totals.rejectedSubmissions > 0} />
            )}
            <Stat label={t('Due within 24 hours')} value={data.totals.dueSoonTasks} href="/tasks?view=active&sort=deadline" icon={<AlarmClock className="h-4 w-4" />} tone="bg-warning-50 text-warning-700" />
            <Stat label={t('Overdue')} value={data.totals.overdueTasks} href="/tasks?view=overdue" icon={<AlertTriangle className="h-4 w-4" />} tone="bg-danger-50 text-danger-700" emphasise={data.totals.overdueTasks > 0} />
            <Stat label={t('Completed')} value={data.totals.completedTasks} href="/tasks?view=completed" icon={<CheckCircle2 className="h-4 w-4" />} tone="bg-success-50 text-success-700" />
            {(data.totals.incomingTransfers > 0 || !isManager) && (
              <Stat label={t('Incoming transfers')} value={data.totals.incomingTransfers} href="/transfers" icon={<ArrowLeftRight className="h-4 w-4" />} tone="bg-brand-50 text-brand-700" emphasise={data.totals.incomingTransfers > 0} />
            )}
            {isManager && (
              <Stat label={t('Awaiting rating')} value={data.totals.awaitingRating} href="/tasks?view=awaiting_rating" icon={<Star className="h-4 w-4" />} tone="bg-brand-50 text-brand-700" />
            )}
          </div>

          <div className="grid gap-4 sm:gap-6 lg:grid-cols-3">
            <Card
              title={t(isManager ? 'Upcoming deadlines' : 'My open tasks')}
              className="lg:col-span-2"
              actions={
                <Link href="/tasks?view=active" className="-my-2 py-2 text-sm font-medium text-brand-700">
                  {t('View all')}
                </Link>
              }
            >
              {data.upcoming.length === 0 ? <Empty title={t('No open tasks')} icon={Inbox} /> : <TaskTable tasks={data.upcoming} emptyText="No open tasks" />}
            </Card>
            <div className="min-w-0 space-y-4 sm:space-y-6">
              {data.performance && (
                <Card
                  title={t('Employee performance')}
                  actions={
                    <Link href="/employees" className="-my-2 py-2 text-sm font-medium text-brand-700">
                      {t('Details')}
                    </Link>
                  }
                >
                  {data.performance.length === 0 ? (
                    <Empty title={t('No employees yet')} icon={Users} />
                  ) : (
                    <ul className="-my-1 divide-y divide-slate-100">
                      {[...data.performance]
                        .sort((a, b) => (b.averageRating ?? -1) - (a.averageRating ?? -1))
                        .slice(0, 6)
                        .map((p) => (
                          <li key={p.employee.id} className="flex items-center justify-between gap-2 py-2">
                            <Link href={`/employees/${p.employee.id}`} className="min-w-0 truncate py-1 text-sm font-medium text-slate-800 hover:text-brand-700">
                              {p.employee.name}
                            </Link>
                            <span className="flex items-center gap-2">
                              <Stars value={p.averageRating} size={14} />
                              <span className="w-8 text-end text-xs tabular-nums text-slate-500">{p.averageRating?.toFixed(1) ?? ''}</span>
                            </span>
                          </li>
                        ))}
                    </ul>
                  )}
                </Card>
              )}
              {data.workload && data.workload.length > 0 && (
                <Card title={t('Employee workload')}>
                  <ul className="-my-1 divide-y divide-slate-100">
                    {data.workload.slice(0, 8).map((w) => (
                      <li key={w.employee.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                        <Link href={`/employees/${w.employee.id}`} className="min-w-0 truncate font-medium text-slate-800 hover:text-brand-700">
                          {w.employee.name}
                        </Link>
                        <span className="flex shrink-0 items-center gap-3 text-xs tabular-nums text-slate-500">
                          <span>{t('{n} open', { n: w.open })}</span>
                          {w.pendingReview > 0 && <span className="text-warning-700">{t('{n} pending', { n: w.pendingReview })}</span>}
                          {w.overdue > 0 && <span className="font-medium text-danger-700">{t('{n} overdue', { n: w.overdue })}</span>}
                        </span>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
              {personal.data && (
                <Card
                  title={
                    <span className="inline-flex items-center gap-2">
                      <Lock className="h-3.5 w-3.5 text-slate-400" aria-hidden /> {t('My personal tasks')}
                    </span>
                  }
                  actions={
                    <Link href="/personal" className="-my-2 py-2 text-sm font-medium text-brand-700">
                      {t('Open')}
                    </Link>
                  }
                >
                  {personal.data.total === 0 ? (
                    <Empty title={t('No open personal tasks')} icon={NotebookPen} />
                  ) : (
                    <>
                      <p className="mb-2 text-xs text-slate-500">{t('{n} open · private to you, not part of company performance', { n: personal.data.total })}</p>
                      <ul className="space-y-1 text-sm">
                        {personal.data.items.slice(0, 4).map((p) => (
                          <li key={p.id} className="truncate text-slate-700">
                            • {p.title}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </Card>
              )}
              <Card title={t('Recent activity')}>
                <ActivityFeed items={data.recentActivity} />
              </Card>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
