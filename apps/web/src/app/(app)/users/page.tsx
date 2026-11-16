'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { UserRole } from '@dailytasks/shared-types';
import { useMe } from '@/components/providers';
import { errorText, useFeedback } from '@/components/feedback';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Select, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';

const roleLabel: Record<UserRole, string> = { COMPANY_ADMIN: 'Admin', PROJECT_MANAGER: 'Project manager', EMPLOYEE: 'Employee' };

export default function UsersPage() {
  const me = useMe();
  const qc = useQueryClient();
  const { t } = useT();
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.users.list() });
  const [form, setForm] = useState({ name: '', email: '', role: 'EMPLOYEE' as UserRole, temporaryPassword: '' });
  const invite = useMutation({
    mutationFn: () => api.users.invite({ ...form, temporaryPassword: form.temporaryPassword || undefined }),
    onSuccess: () => {
      toast(t('Invitation sent'));
      setForm({ name: '', email: '', role: 'EMPLOYEE', temporaryPassword: '' });
      return qc.invalidateQueries({ queryKey: ['users'] });
    },
  });
  const { toast, confirm } = useFeedback();
  const update = useMutation({
    mutationFn: (v: { id: string; role?: UserRole; isActive?: boolean }) => api.users.update(v.id, { role: v.role, isActive: v.isActive }),
    onSuccess: () => {
      toast(t('Saved'));
      return qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (e) => toast(errorText(e), 'error'),
  });
  const [resetFor, setResetFor] = useState<{ id: string; name: string } | null>(null);
  const [tempPassword, setTempPassword] = useState('');
  const reset = useMutation({
    mutationFn: (v: { id: string; temporaryPassword?: string }) => api.users.resetPassword(v.id, { temporaryPassword: v.temporaryPassword }),
    onSuccess: (r) => {
      setResetFor(null);
      setTempPassword('');
      toast(t(r.mode === 'email' ? 'A reset code was e-mailed to the user.' : 'Temporary password set.'));
    },
    onError: (e) => toast(errorText(e), 'error'),
  });

  if (me.role !== 'COMPANY_ADMIN') return <Empty title={t('Only company administrators can manage the team')} />;

  return (
    <>
      <PageHeader title={t('Team')} subtitle={t('Invite people and manage their company role. Add them to projects from the project page.')} />
      <div className="grid gap-4 sm:gap-6 lg:grid-cols-3">
        <Card title={t('Members')} className="lg:col-span-2">
          <ErrorBox error={users.error ?? update.error} />
          {users.isLoading ? (
            <Spinner />
          ) : (
            <ul className="-mx-4 divide-y divide-slate-100 sm:-mx-5">
              {users.data?.map((u) => (
                <li key={u.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-900">{u.name} {!u.isActive && <Badge tone="red">{t('Inactive')}</Badge>}</p>
                    <p className="break-all text-xs text-slate-500">{u.email}</p>
                  </div>
                  <div className="flex w-full items-center gap-2 sm:w-auto">
                    <Select className="flex-1 sm:w-44 sm:flex-none" value={u.role} disabled={u.id === me.id} onChange={(e) => update.mutate({ id: u.id, role: e.target.value as UserRole })} aria-label={t('Role')}>
                      {Object.entries(roleLabel).map(([v, l]) => <option key={v} value={v}>{t(l)}</option>)}
                    </Select>
                    {u.id !== me.id && (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => setResetFor({ id: u.id, name: u.name })}>
                          {t('Reset password')}
                        </Button>
                        <Button
                          size="sm"
                          variant={u.isActive ? 'ghost' : 'secondary'}
                          onClick={async () => {
                            if (u.isActive && !(await confirm({ title: t('Deactivate {name}?', { name: u.name }), message: t('They are signed out everywhere and can no longer sign in. Their history is kept.'), confirmLabel: t('Deactivate'), danger: true }))) return;
                            update.mutate({ id: u.id, isActive: !u.isActive });
                          }}
                        >
                          {t(u.isActive ? 'Deactivate' : 'Activate')}
                        </Button>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
        {resetFor && (
          <Card title={t('Reset password for {name}', { name: resetFor.name })} className="lg:col-span-3">
            <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); reset.mutate({ id: resetFor.id, temporaryPassword: tempPassword || undefined }); }}>
              <p className="text-sm text-slate-600">{t('With Cognito the user receives a reset code by e-mail and chooses a new password on the "Forgot password" page. In local mode, set a temporary password.')}</p>
              <Field label={t('Temporary password (local mode only)')}>
                <Input type="password" autoComplete="new-password" value={tempPassword} onChange={(e) => setTempPassword(e.target.value)} />
              </Field>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button type="submit" loading={reset.isPending}>{t('Reset password')}</Button>
                <Button type="button" variant="ghost" onClick={() => setResetFor(null)}>{t('Cancel')}</Button>
              </div>
            </form>
          </Card>
        )}
        <Card title={t('Invite user')}>
          <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); invite.mutate(); }}>
            <ErrorBox error={invite.error} />
            <Field label={t('Full name')}><Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            <Field label={t('Email')}><Input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
            <Field label={t('Role')}>
              <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as UserRole })}>
                {Object.entries(roleLabel).map(([v, l]) => <option key={v} value={v}>{t(l)}</option>)}
              </Select>
            </Field>
            <Field label={t('Temporary password')} hint={t('Local/dev mode only. In production Cognito e-mails an invitation with a temporary password.')}>
              <Input type="password" autoComplete="new-password" value={form.temporaryPassword} onChange={(e) => setForm({ ...form, temporaryPassword: e.target.value })} />
            </Field>
            <Button type="submit" loading={invite.isPending}>{t(invite.isSuccess ? 'Invited ✓' : 'Send invite')}</Button>
          </form>
        </Card>
      </div>
    </>
  );
}
