'use client';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type ReactNode } from 'react';
import { DocumentsCenter } from '@/components/documents-center';
import { useMe } from '@/components/providers';
import { Stars } from '@/components/stars';
import { TaskTable } from '@/components/task-table';
import { errorText, useFeedback } from '@/components/feedback';
import { Badge, Button, Card, ErrorBox, Field, Input, LinkButton, PageHeader, Select, SkeletonList, Spinner, Tabs, Textarea } from '@/components/ui';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';

type Section = 'overview' | 'tasks' | 'employees' | 'documents';

function Stat({ label, value, href }: { label: string; value: ReactNode; href?: string }) {
  const body = (
    <>
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-semibold tabular-nums text-slate-900">{value}</p>
    </>
  );
  return href ? (
    <Link href={href} className="block rounded-[var(--radius-card)] border border-slate-200 bg-white p-4 transition-colors hover:border-brand-300">
      {body}
    </Link>
  ) : (
    <div className="rounded-[var(--radius-card)] border border-slate-200 bg-white p-4">{body}</div>
  );
}

export default function ProjectDetailPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <ProjectDetail />
    </Suspense>
  );
}

function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const params = useSearchParams();
  const section = ((params.get('tab') as Section) || 'overview') satisfies Section;
  const setSection = (s: Section) => router.replace(s === 'overview' ? `/projects/${id}` : `/projects/${id}?tab=${s}`);
  const me = useMe();
  const qc = useQueryClient();
  const { t } = useT();
  const isAdmin = me.role === 'ADMIN';
  const project = useQuery({ queryKey: ['project', id], queryFn: () => api.projects.get(id) });
  const canManage = isAdmin || project.data?.myRole === 'MANAGER';
  const [view, setView] = useState<'active' | 'pending_review' | 'overdue' | 'completed' | 'awaiting_rating'>('active');
  const tasks = useQuery({ queryKey: ['tasks', view, id], queryFn: () => api.tasks.list({ projectId: id, view, pageSize: 100 }), enabled: section === 'tasks' });
  // Overview counters come from the API's own filters (ledger-based overdue), pageSize 1 = count only.
  const [cActive, cPending, cOverdue, cDone] = useQueries({
    queries: (['active', 'pending_review', 'overdue', 'completed'] as const).map((v) => ({
      queryKey: ['tasks', 'count', v, id],
      queryFn: () => api.tasks.list({ projectId: id, view: v, pageSize: 1 }),
      enabled: section === 'overview',
    })),
  });
  const members = useQuery({ queryKey: ['members', id], queryFn: () => api.projects.members(id), enabled: canManage });
  const perf = useQuery({ queryKey: ['performance', 'project', id], queryFn: () => api.performance.employees(id), enabled: canManage });
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.users.list(), enabled: isAdmin });
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState<'EMPLOYEE' | 'MANAGER'>('EMPLOYEE');

  const refreshMembers = () => Promise.all([qc.invalidateQueries({ queryKey: ['members', id] }), qc.invalidateQueries({ queryKey: ['project', id] })]);
  const add = useMutation({ mutationFn: () => api.projects.addMember(id, { userId, role }), onSuccess: () => { setUserId(''); toast(t('Member added')); return refreshMembers(); } });
  const remove = useMutation({ mutationFn: (uid: string) => api.projects.removeMember(id, uid), onSuccess: () => { toast(t('Member removed')); return refreshMembers(); } });
  const { toast, confirm } = useFeedback();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ name: '', description: '' });
  const save = useMutation({
    mutationFn: () => api.projects.update(id, { name: form.name.trim(), description: form.description.trim() || null }),
    onSuccess: async () => {
      setEditing(false);
      toast(t('Project saved'));
      await Promise.all([qc.invalidateQueries({ queryKey: ['project', id] }), qc.invalidateQueries({ queryKey: ['projects'] })]);
    },
    onError: (e) => toast(errorText(e), 'error'),
  });
  const archive = useMutation({
    mutationFn: () => api.projects.update(id, { status: project.data?.status === 'ARCHIVED' ? 'ACTIVE' : 'ARCHIVED' }),
    onSuccess: () => {
      toast(t(project.data?.status === 'ARCHIVED' ? 'Project restored' : 'Project archived'));
      return qc.invalidateQueries({ queryKey: ['project', id] });
    },
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
            {isAdmin && !editing && (
              <Button variant="secondary" onClick={() => { setForm({ name: p.name, description: p.description ?? '' }); setEditing(true); }}>
                {t('Edit')}
              </Button>
            )}
            {isAdmin && (
              <Button
                variant="secondary"
                loading={archive.isPending}
                onClick={async () => {
                  if (p.status === 'ACTIVE' && !(await confirm({ title: t('Archive {project}?', { project: p.name }), message: t('Archived projects are read-only and hidden from task creation.'), confirmLabel: t('Archive') }))) return;
                  archive.mutate();
                }}
              >
                {t(p.status === 'ARCHIVED' ? 'Unarchive' : 'Archive')}
              </Button>
            )}
          </>
        }
      />
      {editing && (
        <Card className="mb-4 sm:mb-6" title={t('Edit project')}>
          <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
            <Field label={t('Name')}><Input required maxLength={160} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            <Field label={t('Description')}><Textarea rows={3} maxLength={4000} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button type="submit" loading={save.isPending}>{t('Save')}</Button>
              <Button type="button" variant="ghost" onClick={() => setEditing(false)}>{t('Cancel')}</Button>
            </div>
          </form>
        </Card>
      )}
      <Tabs
        value={section}
        onChange={setSection}
        items={[
          { value: 'overview', label: t('Overview') },
          { value: 'tasks', label: t('Tasks') },
          ...(canManage ? [{ value: 'employees' as const, label: t('Employees') }] : []),
          { value: 'documents', label: t('Documents') },
        ]}
      />
      {section === 'overview' && (
        <div className="dt-fade-in space-y-4 sm:space-y-6">
          <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            <Stat label={t('Active tasks')} value={cActive.data?.total ?? '—'} href={`/tasks?projectId=${id}&view=active`} />
            <Stat label={t('Pending approval')} value={cPending.data?.total ?? '—'} href={`/tasks?projectId=${id}&view=pending_review`} />
            <Stat label={t('Overdue')} value={cOverdue.data?.total ?? '—'} href={`/tasks?projectId=${id}&view=overdue`} />
            <Stat label={t('Completed')} value={cDone.data?.total ?? '—'} href={`/tasks?projectId=${id}&view=completed`} />
          </div>
          <Card title={t('About this project')}>
            {p.description ? <p className="whitespace-pre-wrap break-words text-sm text-slate-700">{p.description}</p> : <p className="text-sm text-slate-400">{t('No description')}</p>}
            <p className="mt-3 text-xs text-slate-500">{t('Your role: {role}', { role: t(isAdmin && !p.myRole ? 'Admin' : p.myRole === 'MANAGER' ? 'Project manager' : 'Employee') })}</p>
          </Card>
        </div>
      )}
      {section === 'tasks' && (
        <div className="min-w-0">
          <Tabs
            value={view}
            onChange={setView}
            items={[
              { value: 'active', label: t('Active') },
              { value: 'pending_review', label: t('Pending approval') },
              { value: 'overdue', label: t('Overdue') },
              { value: 'completed', label: t('Completed') },
              ...(canManage ? [{ value: 'awaiting_rating' as const, label: t('Awaiting rating') }] : []),
            ]}
          />
          <Card>{tasks.isLoading ? <SkeletonList rows={5} /> : <TaskTable tasks={tasks.data?.items ?? []} showProject={false} />}</Card>
        </div>
      )}
      {section === 'employees' && canManage && (
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
                        <button aria-label={t('Remove {name}', { name: m.name })} onClick={async () => { if (await confirm({ title: t('Remove {name} from {project}?', { name: m.name, project: p.name }), message: t('They lose access to this project immediately. Their tasks and history are kept.'), confirmLabel: t('Remove'), danger: true })) remove.mutate(m.userId); }} className="-m-2 flex h-10 w-10 items-center justify-center rounded-lg text-slate-400 hover:text-red-600">
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
      {section === 'documents' && <DocumentsCenter projectId={id} canManage={canManage} />}
    </>
  );
}
