'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { errorText, useFeedback } from './feedback';
import { Button, SkeletonList } from './ui';

/** Move one employee between departments (exactly one primary; history kept server-side). */
export function DepartmentEditor({ userId, name, onDone }: { userId: string; name: string; onDone: () => void }) {
  const member = { id: userId, name };
  const all = useQuery({ queryKey: ['departments'], queryFn: () => api.departments.list() });
  const departments = all.data ?? [];
  const qc = useQueryClient();
  const { t, locale } = useT();
  const { toast } = useFeedback();
  const user = useQuery({ queryKey: ['user', member.id], queryFn: () => api.users.get(member.id) });
  const [selected, setSelected] = useState<string[] | null>(null);
  const [primary, setPrimary] = useState<string>('');
  const current = user.data?.departments ?? [];
  const sel = selected ?? current.map((d) => d.id);
  const prim = primary || current.find((d) => d.isPrimary)?.id || sel[0] || '';
  const save = useMutation({
    mutationFn: () => api.users.setDepartments(member.id, sel.map((id) => ({ departmentId: id, isPrimary: id === prim }))),
    onSuccess: () => {
      toast(t('Departments updated'));
      void qc.invalidateQueries({ queryKey: ['user', userId] });
      onDone();
    },
    onError: (e) => toast(errorText(e), 'error'),
  });
  if (user.isLoading || all.isLoading) return <SkeletonList rows={1} />;
  return (
    <form
      className="dt-fade-in mt-2 space-y-3 rounded-lg bg-slate-50 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (sel.length && sel.includes(prim)) save.mutate();
      }}
    >
      <fieldset>
        <legend className="mb-2 text-sm font-medium text-slate-700">{t('Departments of {name}', { name: member.name })}</legend>
        <ul className="grid gap-1 sm:grid-cols-2">
          {departments
            .filter((d) => d.isActive)
            .map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-2 rounded-md bg-white px-3 py-2">
                <label className="flex min-h-8 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-brand-600"
                    checked={sel.includes(d.id)}
                    onChange={(e) => setSelected(e.target.checked ? [...sel, d.id] : sel.filter((x) => x !== d.id))}
                  />
                  {locale === 'ar' ? d.nameAr : d.nameEn}
                </label>
                {sel.includes(d.id) && (
                  <label className="flex items-center gap-1 text-xs text-slate-500">
                    <input type="radio" name={`primary-${member.id}`} className="accent-brand-600" checked={prim === d.id} onChange={() => setPrimary(d.id)} />
                    {t('Primary')}
                  </label>
                )}
              </li>
            ))}
        </ul>
      </fieldset>
      <Button size="sm" type="submit" loading={save.isPending} disabled={!sel.length || !sel.includes(prim)}>
        {t('Save')}
      </Button>
    </form>
  );
}

