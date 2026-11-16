'use client';
import { useQuery } from '@tanstack/react-query';
import { FolderOpen } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect } from 'react';
import { DocumentsCenter } from '@/components/documents-center';
import { useMe } from '@/components/providers';
import { Card, Empty, ErrorBox, Field, PageHeader, Select, SkeletonList, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';

/** Documents across the caller's projects (one project at a time; visibility enforced by the API). */
function Documents() {
  const { t } = useT();
  const me = useMe();
  const router = useRouter();
  const params = useSearchParams();
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api.projects.list() });
  const list = projects.data ?? [];
  const projectId = params.get('projectId') ?? '';
  useEffect(() => {
    if (!projectId && list.length) router.replace(`/documents?projectId=${list[0]!.id}`);
  }, [projectId, list, router]);
  const current = list.find((p) => p.id === projectId);
  const canManage = me.role === 'ADMIN' || current?.myRole === 'MANAGER';
  return (
    <>
      <PageHeader title={t('Documents')} subtitle={t('Project files, drawings, contracts and approved task deliverables.')} />
      <ErrorBox error={projects.error} />
      {projects.isLoading ? (
        <Card>
          <SkeletonList rows={3} />
        </Card>
      ) : !list.length ? (
        <Empty title={t('No projects yet')} icon={FolderOpen} />
      ) : (
        <>
          <div className="mb-4 max-w-sm">
            <Field label={t('Project')}>
              <Select value={projectId} onChange={(e) => router.replace(`/documents?projectId=${e.target.value}`)}>
                {list.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          {current && <DocumentsCenter key={current.id} projectId={current.id} canManage={canManage} />}
        </>
      )}
    </>
  );
}

export default function DocumentsPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <Documents />
    </Suspense>
  );
}
