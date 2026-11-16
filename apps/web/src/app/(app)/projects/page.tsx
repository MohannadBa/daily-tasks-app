'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { useMe } from '@/components/providers';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Spinner, Textarea } from '@/components/ui';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';

export default function ProjectsPage() {
  const me = useMe();
  const qc = useQueryClient();
  const { t } = useT();
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api.projects.list() });
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const create = useMutation({
    mutationFn: () => api.projects.create({ name, description: description || null }),
    onSuccess: async () => {
      setShowForm(false);
      setName('');
      setDescription('');
      await qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });

  return (
    <>
      <PageHeader title={t('Projects')} actions={me.role === 'ADMIN' && <Button onClick={() => setShowForm((s) => !s)}>{t('New project')}</Button>} />
      {showForm && (
        <Card className="mb-6" title={t('Create project')}>
          <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
            <ErrorBox error={create.error} />
            <Field label={t('Name')}><Input required value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <Field label={t('Description')}><Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
            <Button type="submit" loading={create.isPending}>{t('Create')}</Button>
          </form>
        </Card>
      )}
      <ErrorBox error={projects.error} />
      {projects.isLoading ? (
        <Spinner />
      ) : projects.data?.length === 0 ? (
        <Empty title={t('No projects yet')} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3">
          {projects.data?.map((p) => (
            <Link key={p.id} href={`/projects/${p.id}`} className="min-w-0 rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-brand-500/40 hover:shadow active:bg-slate-50 sm:p-5">
              <div className="flex items-start justify-between gap-2">
                <h2 className="min-w-0 break-words font-semibold text-slate-900">{p.name}</h2>
                {p.status === 'ARCHIVED' ? <Badge>{t('Archived')}</Badge> : p.myRole && <Badge tone="blue">{t(p.myRole === 'MANAGER' ? 'Manager' : 'Member')}</Badge>}
              </div>
              {p.description && <p className="mt-1 line-clamp-2 text-sm text-slate-500">{p.description}</p>}
              <div className="mt-4 flex gap-4 text-sm text-slate-600">
                <span><strong className="text-slate-900">{p.openTaskCount}</strong> {t('open tasks')}</span>
                <span><strong className="text-slate-900">{p.memberCount}</strong> {t('members')}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
