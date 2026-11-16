'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, KeyRound, Search, ShieldCheck, UserPlus, X } from 'lucide-react';
import { useState } from 'react';
import type { UserDto, UserRole } from '@dailytasks/shared-types';
import { DepartmentEditor } from '@/components/department-editor';
import { errorText, useFeedback } from '@/components/feedback';
import { useMe } from '@/components/providers';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Select, SkeletonList, Tabs } from '@/components/ui';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useT } from '@/lib/i18n';

const roleLabel: Record<UserRole, string> = { ADMIN: 'Admin', PROJECT_MANAGER: 'Project manager', EMPLOYEE: 'Employee' };
const auditLabel: Record<string, string> = {
  USER_CREATED: 'Account created',
  USER_ACTIVATED: 'Account activated',
  USER_DEACTIVATED: 'Account deactivated',
  USER_ROLE_CHANGED: 'Role changed',
  USER_UPDATED: 'Profile updated',
  USER_DEPARTMENTS_CHANGED: 'Departments changed',
  PASSWORD_RESET: 'Password reset by admin',
  PASSWORD_CHANGED: 'Password changed by user',
};

/**
 * A generated temporary password, shown exactly once from the API response. It lives only in this
 * component's memory (never browser storage, never logged) and disappears when dismissed.
 */
function OnboardingCard({ name, email, password, onClose }: { name: string; email: string; password?: string; onClose: () => void }) {
  const { t } = useT();
  const { toast } = useFeedback();
  return (
    <Card className="dt-fade-in border-brand-300" title={<span className="inline-flex items-center gap-2"><KeyRound className="h-4 w-4" aria-hidden /> {t('Onboarding: {name}', { name })}</span>}>
      {password ? (
        <>
          <p className="text-sm text-slate-600">{t('Share these sign-in details privately (in person or by phone). The password is shown only once.')}</p>
          <dl className="mt-3 space-y-2 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2">
              <dt className="text-slate-500">{t('Email')}</dt>
              <dd className="font-medium text-slate-900" dir="ltr">{email}</dd>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2">
              <dt className="text-slate-500">{t('Temporary password')}</dt>
              <dd className="flex items-center gap-2">
                <span className="select-all font-mono text-base tracking-wider text-slate-900" dir="ltr" data-testid="temporary-password">{password}</span>
                <button
                  onClick={() => void navigator.clipboard?.writeText(password).then(() => toast(t('Copied')), () => undefined)}
                  aria-label={t('Copy password')}
                  className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 hover:bg-white"
                >
                  <Copy className="h-4 w-4" aria-hidden />
                </button>
              </dd>
            </div>
          </dl>
        </>
      ) : (
        <p className="text-sm text-slate-600">{t('The user receives an invitation e-mail with a temporary password.')}</p>
      )}
      <ol className="mt-4 list-decimal space-y-1 ps-5 text-sm text-slate-600">
        <li>{t('Open Al-Rasiyat and sign in with the e-mail and temporary password.')}</li>
        <li>{t('Choose a new password when asked (required before anything else).')}</li>
        <li>{t('Install the app on the phone and enable notifications.')}</li>
      </ol>
      <Button className="mt-4" variant="secondary" onClick={onClose}>
        {t('Done')}
      </Button>
    </Card>
  );
}

function CreateUser({ onCreated }: { onCreated: (u: { name: string; email: string; password?: string }) => void }) {
  const { t, locale } = useT();
  const qc = useQueryClient();
  const departments = useQuery({ queryKey: ['departments'], queryFn: () => api.departments.list() });
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api.projects.list() });
  const [f, setF] = useState({ name: '', email: '', role: 'EMPLOYEE' as UserRole, language: 'ar' as 'ar' | 'en', temporaryPassword: '' });
  const [depts, setDepts] = useState<string[]>([]);
  const [primary, setPrimary] = useState('');
  const [proj, setProj] = useState<Record<string, 'MANAGER' | 'EMPLOYEE' | ''>>({});
  const create = useMutation({
    mutationFn: () =>
      api.users.invite({
        name: f.name.trim(),
        email: f.email.trim(),
        role: f.role,
        locale: f.language,
        temporaryPassword: f.temporaryPassword || undefined,
        departments: depts.map((id) => ({ departmentId: id, isPrimary: id === (primary || depts[0]) })),
        projects: Object.entries(proj)
          .filter(([, r]) => r)
          .map(([projectId, role]) => ({ projectId, role: role as 'MANAGER' | 'EMPLOYEE' })),
      }),
    onSuccess: async (u) => {
      onCreated({ name: u.name, email: u.email, password: u.temporaryPassword });
      setF({ name: '', email: '', role: 'EMPLOYEE', language: 'ar', temporaryPassword: '' });
      setDepts([]);
      setPrimary('');
      setProj({});
      await qc.invalidateQueries({ queryKey: ['users'] });
    },
  });
  const needsDept = f.role === 'EMPLOYEE' && depts.length === 0;
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!needsDept) create.mutate();
      }}
    >
      <ErrorBox error={create.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('Full name')}>
          <Input required maxLength={120} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field label={t('Email')}>
          <Input type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} dir="ltr" />
        </Field>
        <Field label={t('Role')}>
          <Select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as UserRole })}>
            {Object.entries(roleLabel).map(([v, l]) => (
              <option key={v} value={v}>
                {t(l)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('Language')}>
          <Select value={f.language} onChange={(e) => setF({ ...f, language: e.target.value as 'ar' | 'en' })}>
            <option value="ar">العربية</option>
            <option value="en">English</option>
          </Select>
        </Field>
      </div>
      <fieldset>
        <legend className="mb-1 text-sm font-medium text-slate-700">
          {t('Departments')} {f.role === 'EMPLOYEE' && <span className="text-xs font-normal text-slate-500">({t('required for employees')})</span>}
        </legend>
        <ul className="grid gap-1 sm:grid-cols-2">
          {(departments.data ?? []).map((d) => (
            <li key={d.id} className="flex items-center justify-between gap-2 rounded-md border border-slate-200 px-3 py-1.5">
              <label className="flex min-h-8 items-center gap-2 text-sm">
                <input type="checkbox" className="h-4 w-4 accent-brand-600" checked={depts.includes(d.id)} onChange={(e) => setDepts(e.target.checked ? [...depts, d.id] : depts.filter((x) => x !== d.id))} />
                {locale === 'ar' ? d.nameAr : d.nameEn}
              </label>
              {depts.includes(d.id) && depts.length > 1 && (
                <label className="flex items-center gap-1 text-xs text-slate-500">
                  <input type="radio" name="new-primary" className="accent-brand-600" checked={(primary || depts[0]) === d.id} onChange={() => setPrimary(d.id)} />
                  {t('Primary')}
                </label>
              )}
            </li>
          ))}
        </ul>
      </fieldset>
      <fieldset>
        <legend className="mb-1 text-sm font-medium text-slate-700">{t('Projects (optional)')}</legend>
        <ul className="grid gap-1 sm:grid-cols-2">
          {(projects.data ?? [])
            .filter((p) => p.status === 'ACTIVE')
            .map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-2 rounded-md border border-slate-200 px-3 py-1.5 text-sm">
                <span className="min-w-0 truncate">{p.name}</span>
                <Select className="w-40 shrink-0" value={proj[p.id] ?? ''} onChange={(e) => setProj({ ...proj, [p.id]: e.target.value as 'MANAGER' | 'EMPLOYEE' | '' })} aria-label={t('Role in {project}', { project: p.name })}>
                  <option value="">{t('Not a member')}</option>
                  <option value="EMPLOYEE">{t('Employee')}</option>
                  {f.role !== 'EMPLOYEE' && <option value="MANAGER">{t('Project manager')}</option>}
                </Select>
              </li>
            ))}
        </ul>
      </fieldset>
      <Field label={t('Temporary password (optional)')} hint={t('Leave empty to generate a secure one, shown once. In production Cognito can e-mail it instead.')}>
        <Input type="password" autoComplete="new-password" value={f.temporaryPassword} onChange={(e) => setF({ ...f, temporaryPassword: e.target.value })} />
      </Field>
      <Button type="submit" loading={create.isPending} disabled={needsDept}>
        <UserPlus className="h-4 w-4" aria-hidden /> {t('Create account')}
      </Button>
    </form>
  );
}

function UserDetail({ user, onClose, onPassword }: { user: UserDto; onClose: () => void; onPassword: (p: { name: string; email: string; password?: string }) => void }) {
  const { t, locale } = useT();
  const me = useMe();
  const qc = useQueryClient();
  const { toast, confirm } = useFeedback();
  const [tab, setTab] = useState<'access' | 'audit'>('access');
  const audit = useQuery({ queryKey: ['user-audit', user.id], queryFn: () => api.users.audit(user.id), enabled: tab === 'audit' });
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api.projects.list() });
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['users'] }), qc.invalidateQueries({ queryKey: ['user', user.id] }), qc.invalidateQueries({ queryKey: ['user-audit', user.id] })]);
  const update = useMutation({
    mutationFn: (body: { role?: UserRole; isActive?: boolean }) => api.users.update(user.id, body),
    onSuccess: () => {
      toast(t('Saved'));
      return refresh();
    },
    onError: (e) => toast(errorText(e), 'error'),
  });
  const reset = useMutation({
    mutationFn: () => api.users.resetPassword(user.id, {}),
    onSuccess: (r) => {
      onPassword({ name: user.name, email: user.email, password: r.temporaryPassword });
      toast(t(r.mode === 'email' ? 'A reset code was e-mailed to the user.' : 'Temporary password set.'));
      return refresh();
    },
    onError: (e) => toast(errorText(e), 'error'),
  });
  const addToProject = useMutation({
    mutationFn: (v: { projectId: string; role: 'MANAGER' | 'EMPLOYEE' }) => api.projects.addMember(v.projectId, { userId: user.id, role: v.role }),
    onSuccess: () => {
      toast(t('Member added'));
      return qc.invalidateQueries({ queryKey: ['members'] });
    },
    onError: (e) => toast(errorText(e), 'error'),
  });
  const [projectId, setProjectId] = useState('');
  const self = user.id === me.id;
  return (
    <Card
      className="dt-fade-in"
      title={
        <span>
          {user.name} {!user.isActive && <Badge tone="red">{t('Inactive')}</Badge>} {user.mustChangePassword && <Badge tone="amber">{t('Must change password')}</Badge>}
        </span>
      }
      actions={
        <button onClick={onClose} aria-label={t('Close')} className="-my-2 flex h-10 w-10 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100">
          <X className="h-4 w-4" aria-hidden />
        </button>
      }
    >
      <p className="mb-3 text-sm text-slate-500" dir="ltr">
        {user.email}
      </p>
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { value: 'access', label: t('Access') },
          { value: 'audit', label: t('Account history') },
        ]}
      />
      {tab === 'access' ? (
        <div className="space-y-5">
          <div className="flex flex-wrap items-end gap-2">
            <Field label={t('Role')}>
              <Select value={user.role} disabled={self} onChange={(e) => update.mutate({ role: e.target.value as UserRole })}>
                {Object.entries(roleLabel).map(([v, l]) => (
                  <option key={v} value={v}>
                    {t(l)}
                  </option>
                ))}
              </Select>
            </Field>
            {!self && (
              <>
                <Button
                  variant="secondary"
                  loading={reset.isPending}
                  onClick={async () => {
                    if (await confirm({ title: t('Reset the password of {name}?', { name: user.name }), message: t('A new temporary password is issued and must be changed at next sign-in.'), confirmLabel: t('Reset password') })) reset.mutate();
                  }}
                >
                  <KeyRound className="h-4 w-4" aria-hidden /> {t('Reset password')}
                </Button>
                <Button
                  variant={user.isActive ? 'ghost' : 'secondary'}
                  onClick={async () => {
                    if (user.isActive && !(await confirm({ title: t('Deactivate {name}?', { name: user.name }), message: t('They are signed out everywhere and can no longer sign in. Their history is kept.'), confirmLabel: t('Deactivate'), danger: true }))) return;
                    update.mutate({ isActive: !user.isActive });
                  }}
                >
                  {t(user.isActive ? 'Deactivate' : 'Activate')}
                </Button>
              </>
            )}
          </div>
          <div>
            <p className="mb-1 text-sm font-medium text-slate-700">{t('Departments')}</p>
            <p className="mb-2 text-sm text-slate-600">{user.departments?.length ? user.departments.map((d) => `${locale === 'ar' ? d.nameAr : d.nameEn}${d.isPrimary ? ` (${t('Primary')})` : ''}`).join('، ') : '—'}</p>
            <DepartmentEditor key={user.id} userId={user.id} name={user.name} onDone={() => void refresh()} />
          </div>
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (projectId) addToProject.mutate({ projectId, role: user.role === 'EMPLOYEE' ? 'EMPLOYEE' : 'MANAGER' });
            }}
          >
            <Field label={t('Add to project')}>
              <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">{t('Select a project…')}</option>
                {(projects.data ?? [])
                  .filter((p) => p.status === 'ACTIVE')
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </Select>
            </Field>
            <Button type="submit" variant="secondary" disabled={!projectId} loading={addToProject.isPending}>
              {t(user.role === 'EMPLOYEE' ? 'Add as employee' : 'Add as project manager')}
            </Button>
          </form>
        </div>
      ) : audit.isLoading ? (
        <SkeletonList rows={3} />
      ) : !audit.data?.length ? (
        <Empty title={t('No account history yet')} />
      ) : (
        <ol className="space-y-2">
          {audit.data.map((a) => (
            <li key={a.id} className="text-sm">
              <span className="font-medium text-slate-900">{t(auditLabel[a.action] ?? a.action)}</span>
              <span className="text-slate-500">
                {' '}
                · {a.actor?.name ?? t('System')} · {formatDateTime(a.createdAt)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

export default function UsersPage() {
  const me = useMe();
  const { t, locale } = useT();
  const [role, setRole] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [onboarding, setOnboarding] = useState<{ name: string; email: string; password?: string } | null>(null);
  const users = useQuery({
    queryKey: ['users', role, departmentId, search],
    queryFn: () => api.users.list({ role: role || undefined, departmentId: departmentId || undefined, q: search || undefined }),
    enabled: me.role === 'ADMIN',
  });
  const departments = useQuery({ queryKey: ['departments'], queryFn: () => api.departments.list(), enabled: me.role === 'ADMIN' });
  if (me.role !== 'ADMIN') return <Empty title={t('Only company administrators can manage the team')} icon={ShieldCheck} />;
  const sel = users.data?.find((u) => u.id === selected);
  return (
    <>
      <PageHeader
        title={t('Administration')}
        subtitle={t('Create accounts, assign departments and projects, and control access.')}
        actions={
          !creating && (
            <Button onClick={() => setCreating(true)}>
              <UserPlus className="h-4 w-4" aria-hidden /> {t('New account')}
            </Button>
          )
        }
      />
      <div className="space-y-4 sm:space-y-6">
        {onboarding && <OnboardingCard {...onboarding} onClose={() => setOnboarding(null)} />}
        {creating && (
          <Card
            className="dt-fade-in"
            title={t('New account')}
            actions={
              <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>
                {t('Cancel')}
              </Button>
            }
          >
            <CreateUser
              onCreated={(u) => {
                setCreating(false);
                setOnboarding(u);
              }}
            />
          </Card>
        )}
        <div className="grid gap-4 sm:gap-6 lg:grid-cols-5">
          <Card title={t('Members')} className={sel ? 'lg:col-span-2' : 'lg:col-span-5'}>
            <div className="mb-4 grid gap-2 sm:grid-cols-[1fr_auto_auto]">
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  setSearch(q.trim());
                }}
              >
                <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Search name or e-mail…')} aria-label={t('Search')} />
                <Button type="submit" variant="secondary" aria-label={t('Search')}>
                  <Search className="h-4 w-4" aria-hidden />
                </Button>
              </form>
              <Select value={role} onChange={(e) => setRole(e.target.value)} aria-label={t('Role')}>
                <option value="">{t('All roles')}</option>
                {Object.entries(roleLabel).map(([v, l]) => (
                  <option key={v} value={v}>
                    {t(l)}
                  </option>
                ))}
              </Select>
              <Select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} aria-label={t('Department')}>
                <option value="">{t('All departments')}</option>
                {(departments.data ?? []).map((d) => (
                  <option key={d.id} value={d.id}>
                    {locale === 'ar' ? d.nameAr : d.nameEn}
                  </option>
                ))}
              </Select>
            </div>
            <ErrorBox error={users.error} />
            {users.isLoading ? (
              <SkeletonList rows={5} />
            ) : !users.data?.length ? (
              <Empty title={t('No users match')} />
            ) : (
              <ul className="-mx-4 divide-y divide-slate-100 sm:-mx-5">
                {users.data.map((u) => (
                  <li key={u.id}>
                    <button onClick={() => setSelected(u.id)} className={`flex w-full items-center justify-between gap-3 px-4 py-3 text-start hover:bg-slate-50 sm:px-5 ${selected === u.id ? 'bg-brand-50' : ''}`}>
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-slate-900">
                          {u.name} {!u.isActive && <Badge tone="red">{t('Inactive')}</Badge>}
                        </span>
                        <span className="block truncate text-xs text-slate-500">
                          {u.email}
                          {u.departments?.length ? ` · ${u.departments.map((d) => (locale === 'ar' ? d.nameAr : d.nameEn)).join('، ')}` : ''}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        {u.mustChangePassword && <Badge tone="amber">{t('Pending first sign-in')}</Badge>}
                        <Badge tone={u.role === 'ADMIN' ? 'red' : u.role === 'PROJECT_MANAGER' ? 'blue' : 'gray'}>{t(roleLabel[u.role])}</Badge>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          {sel && (
            <div className="lg:col-span-3">
              <UserDetail user={sel} onClose={() => setSelected(null)} onPassword={setOnboarding} />
            </div>
          )}
        </div>
      </div>
    </>
  );
}
