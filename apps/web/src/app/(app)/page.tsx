'use client';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, ClipboardList, FolderKanban, Star } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { useIsManager, useMe } from '@/components/providers';
import { Stars } from '@/components/stars';
import { TaskTable } from '@/components/task-table';
import { Card, Empty, ErrorBox, LinkButton, PageHeader, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';

function Stat({ label, value, icon, href, tone }: { label: string; value: number; icon: ReactNode; href: string; tone: string }) {
  return (
    <Link href={href} className="group rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-brand-500/40 hover:shadow">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-slate-500">{label}</span>
        <span className={`rounded-lg p-2 ${tone}`}>{icon}</span>
      </div>
      <p className="mt-3 text-3xl font-semibold text-slate-900">{value}</p>
    </Link>
  );
}

export default function DashboardPage() {
  const me = useMe();
  const isManager = useIsManager();
  const { t } = useT();
  const { data, error, isLoading } = useQuery({ queryKey: ['dashboard'], queryFn: () => api.dashboard.get() });

  return (
    <>
      <PageHeader
        title={t('Welcome, {name}', { name: me.name.split(' ')[0] })}
        subtitle={t(isManager ? 'Overview of your projects and team' : 'Your tasks at a glance')}
        actions={isManager && <LinkButton href="/tasks/new">{t('New task')}</LinkButton>}
      />
      <ErrorBox error={error} />
      {isLoading || !data ? (
        <Spinner />
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
            <Stat label={t('Projects')} value={data.totals.projects} href="/projects" icon={<FolderKanban className="h-4 w-4" />} tone="bg-brand-50 text-brand-700" />
            <Stat label={t('Active tasks')} value={data.totals.activeTasks} href="/tasks?view=active" icon={<ClipboardList className="h-4 w-4" />} tone="bg-blue-50 text-blue-700" />
            <Stat label={t('Completed')} value={data.totals.completedTasks} href="/tasks?view=completed" icon={<CheckCircle2 className="h-4 w-4" />} tone="bg-emerald-50 text-emerald-700" />
            <Stat label={t('Overdue')} value={data.totals.overdueTasks} href="/tasks?view=overdue" icon={<AlertTriangle className="h-4 w-4" />} tone="bg-red-50 text-red-700" />
            {isManager && (
              <Stat label={t('Awaiting rating')} value={data.totals.awaitingRating} href="/tasks?view=awaiting_rating" icon={<Star className="h-4 w-4" />} tone="bg-amber-50 text-amber-700" />
            )}
          </div>

          <div className="grid gap-6 lg:grid-cols-3">
            <Card title={t('Upcoming deadlines')} className="lg:col-span-2" actions={<Link href="/tasks?view=active" className="text-sm text-brand-700">{t('View all')}</Link>}>
              <TaskTable tasks={data.upcoming} emptyText="No open tasks" />
            </Card>
            {data.performance && (
              <Card title={t('Employee performance')} actions={<Link href="/employees" className="text-sm text-brand-700">{t('Details')}</Link>}>
                {data.performance.length === 0 ? (
                  <Empty title={t('No employees yet')} />
                ) : (
                  <ul className="divide-y divide-slate-100">
                    {[...data.performance]
                      .sort((a, b) => (b.averageRating ?? -1) - (a.averageRating ?? -1))
                      .slice(0, 8)
                      .map((p) => (
                        <li key={p.employee.id} className="flex items-center justify-between py-2.5">
                          <Link href={`/employees/${p.employee.id}`} className="text-sm font-medium text-slate-800 hover:text-brand-700">
                            {p.employee.name}
                          </Link>
                          <span className="flex items-center gap-2">
                            <Stars value={p.averageRating} size={14} />
                            <span className="w-8 text-end text-xs text-slate-500">{p.averageRating?.toFixed(1) ?? ''}</span>
                          </span>
                        </li>
                      ))}
                  </ul>
                )}
              </Card>
            )}
          </div>
        </div>
      )}
    </>
  );
}
