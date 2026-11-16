'use client';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { Stars } from '@/components/stars';
import { Card, Empty, ErrorBox, PageHeader, Select, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';

export default function EmployeesPage() {
  const [projectId, setProjectId] = useState('');
  const { t } = useT();
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api.projects.list() });
  const perf = useQuery({ queryKey: ['performance', 'list', projectId], queryFn: () => api.performance.employees(projectId || undefined) });
  const manageable = (projects.data ?? []).filter((p) => p.myRole === 'MANAGER' || p.myRole === null);

  return (
    <>
      <PageHeader title={t('Employees')} subtitle={t('Performance ratings are private to managers and administrators.')} />
      <Card
        actions={
          <Select className="w-full sm:w-56" value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label={t('All my projects')}>
            <option value="">{t('All my projects')}</option>
            {manageable.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        }
        title={t('Performance')}
      >
        <ErrorBox error={perf.error} />
        {perf.isLoading ? (
          <Spinner />
        ) : !perf.data?.length ? (
          <Empty title={t('No employees found')} />
        ) : (
          <>
          <ul className="-mx-4 divide-y divide-slate-100 sm:-mx-5 md:hidden">
            {perf.data.map((p) => (
              <li key={p.employee.id}>
                <Link href={`/employees/${p.employee.id}${projectId ? `?projectId=${projectId}` : ''}`} className="block px-4 py-3 active:bg-slate-50">
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate font-medium text-slate-900">{p.employee.name}</span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      <Stars value={p.averageRating} size={14} />
                      {p.averageRating !== null && <span className="text-sm font-medium text-slate-700">{p.averageRating.toFixed(2)}</span>}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                    <span>{t('Rated')}: {p.ratedTaskCount}</span>
                    <span>{t('Completed')}: {p.completedTaskCount}</span>
                    <span>{t('Open')}: {p.openTaskCount}</span>
                    <span className={p.overdueTaskCount ? 'font-medium text-red-600' : undefined}>{t('Overdue')}: {p.overdueTaskCount}</span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
          <div className="-mx-5 hidden overflow-x-auto md:block">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-start text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-5 py-2 font-medium">{t('Employee')}</th>
                  <th className="px-3 py-2 font-medium">{t('Average rating')}</th>
                  <th className="px-3 py-2 text-end font-medium">{t('Rated')}</th>
                  <th className="px-3 py-2 text-end font-medium">{t('Completed')}</th>
                  <th className="px-3 py-2 text-end font-medium">{t('Open')}</th>
                  <th className="px-5 py-2 text-end font-medium">{t('Overdue')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {perf.data.map((p) => (
                  <tr key={p.employee.id} className="hover:bg-slate-50">
                    <td className="px-5 py-3">
                      <Link href={`/employees/${p.employee.id}${projectId ? `?projectId=${projectId}` : ''}`} className="font-medium text-slate-900 hover:text-brand-700">{p.employee.name}</Link>
                      <div className="text-xs text-slate-400">{p.employee.email}</div>
                    </td>
                    <td className="px-3 py-3">
                      <span className="flex items-center gap-2">
                        <Stars value={p.averageRating} size={14} />
                        {p.averageRating !== null && <span className="font-medium text-slate-700">{p.averageRating.toFixed(2)}</span>}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-end text-slate-600">{p.ratedTaskCount}</td>
                    <td className="px-3 py-3 text-end text-slate-600">{p.completedTaskCount}</td>
                    <td className="px-3 py-3 text-end text-slate-600">{p.openTaskCount}</td>
                    <td className={`px-5 py-3 text-end ${p.overdueTaskCount ? 'font-medium text-red-600' : 'text-slate-600'}`}>{p.overdueTaskCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </>
        )}
      </Card>
    </>
  );
}
