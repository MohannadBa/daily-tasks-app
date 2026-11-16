'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useMe } from '@/components/providers';
import { Stars } from '@/components/stars';
import { TaskTable } from '@/components/task-table';
import { Badge, Button, Card, ErrorBox, LinkButton, PageHeader, Select, Spinner, Tabs } from '@/components/ui';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';

export default function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const me = useMe();
  const qc = useQueryClient();
  const { t } = useT();
  const isAdmin = me.role === 'COMPANY_ADMIN';
  const project = useQuery({ queryKey: ['project', id], queryFn: () => api.projects.get(id) });
  const canManage = isAdmin || project.data?.myRole === 'MANAGER';
  const [view, setView] = useState<'active' | 'overdue' | 'completed' | 'awaiting_rating'>('active');
  const tasks = useQuery({ queryKey: ['tasks', view, id], queryFn: () => api.tasks.list({ projectId: id, view, pageSize: 100 }) });
  const members = useQuery({ queryKey: ['members', id], queryFn: () => api.projects.members(id), enabled: canManage });
  const perf = useQuery({ queryKey: ['performance', 'project', id], queryFn: () => api.performance.employees(id), enabled: canManage });
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.users.list(), enabled: isAdmin });
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState<'EMPLOYEE' | 'MANAGER'>('EMPLOYEE');

  const refreshMembers = () => Promise.all([qc.invalidateQueries({ queryKey: ['members', id] }), qc.invalidateQueries({ queryKey: ['project', id] })]);
  const add = useMutation({ mutationFn: () => api.projects.addMember(id, { userId, role }), onSuccess: () => { setUserId(''); return refreshMembers(); } });
  const remove = useMutation({ mutationFn: (uid: string) => api.projects.removeMember(id, uid), onSuccess: refreshMembers });
  const archive = useMutation({
    mutationFn: () => api.projects.update(id, { status: project.data?.status === 'ARCHIVED' ? 'ACTIVE' : 'ARCHIVED' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project', id] }),
  });

  if (project.isLoading) return <Spinner />;
  if (!project.data) return <ErrorBox error={project.error ?? t('Project not found')} />;
  const p = project.data;
  const memberIds = new Set(members.data?.map((m) => m.userId));
  const candidates = (users.data ?? []).filter((u) => u.isActive && !memberIds.has(u.id) && (role === 'EMPLOYEE' || u.role !== 'EMPLOYEE'));

  return (
    <>
      <PageHeader
        title={p.name}
        subtitle={p.description}
        actions={
          <>
            {p.status === 'ARCHIVED' && <Badge>{t('Archived')}</Badge>}
            {canManage && p.status === 'ACTIVE' && <LinkButton href={`/tasks/new?projectId=${id}`}>{t('New task')}</LinkButton>}
            {isAdmin && <Button variant="secondary" onClick={() => archive.mutate()} loading={archive.isPending}>{t(p.status === 'ARCHIVED' ? 'Unarchive' : 'Archive')}</Button>}
          </>
        }
      />
      <div className="grid gap-4 sm:gap-6 lg:grid-cols-3">
        <div className="min-w-0 lg:col-span-2">
          <Tabs
            value={view}
            onChange={setView}
            items={[
              { value: 'active', label: t('Active') },
              { value: 'overdue', label: t('Overdue') },
              { value: 'completed', label: t('Completed') },
              ...(canManage ? [{ value: 'awaiting_rating' as const, label: t('Awaiting rating') }] : []),
            ]}
          />
          <Card>{tasks.isLoading ? <Spinner /> : <TaskTable tasks={tasks.data?.items ?? []} showProject={false} />}</Card>
        </div>
        {canManage && (
          <Card title={t('Team ({n})', { n: members.data?.length ?? 0 })}>
            <ErrorBox error={add.error ?? remove.error} />
            <ul className="divide-y divide-slate-100">
              {members.data?.map((m) => {
                const pr = perf.data?.find((x) => x.employee.id === m.userId);
                return (
                  <li key={m.userId} className="flex items-center justify-between gap-2 py-2.5">
                    <div className="min-w-0">
                      {m.role === 'EMPLOYEE' ? (
                        <Link href={`/employees/${m.userId}?projectId=${id}`} className="block truncate text-sm font-medium text-slate-900 hover:text-brand-700">{m.name}</Link>
                      ) : (
                        <span className="block truncate text-sm font-medium text-slate-900">{m.name}</span>
                      )}
                      <span className="text-xs text-slate-500">{t(m.role === 'MANAGER' ? 'Project manager' : 'Employee')}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      {pr && <Stars value={pr.averageRating} size={12} />}
                      {isAdmin && (
                        <button aria-label={t('Remove {name}', { name: m.name })} onClick={() => confirm(t('Remove {name} from {project}?', { name: m.name, project: p.name })) && remove.mutate(m.userId)} className="-m-2 flex h-10 w-10 items-center justify-center rounded-lg text-slate-400 hover:text-red-600">
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
            {isAdmin && (
              <form className="mt-4 space-y-2 border-t border-slate-100 pt-4" onSubmit={(e) => { e.preventDefault(); if (userId) add.mutate(); }}>
                <p className="text-sm font-medium text-slate-700">{t('Add member')}</p>
                <Select value={role} onChange={(e) => { setRole(e.target.value as 'EMPLOYEE' | 'MANAGER'); setUserId(''); }} aria-label={t('Role')}>
                  <option value="EMPLOYEE">{t('Employee')}</option>
                  <option value="MANAGER">{t('Project manager')}</option>
                </Select>
                <Select value={userId} onChange={(e) => setUserId(e.target.value)} aria-label={t('User')}>
                  <option value="">{t('Select a user…')}</option>
                  {candidates.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}
                </Select>
                <Button size="sm" type="submit" disabled={!userId} loading={add.isPending}>{t('Add')}</Button>
              </form>
            )}
          </Card>
        )}
      </div>
    </>
  );
}
