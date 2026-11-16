'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { TaskForm } from '@/components/task-form';
import { Card, Empty, ErrorBox, PageHeader, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { uploadFiles } from '@/lib/files';
import { useT } from '@/lib/i18n';

export default function EditTaskPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const { t } = useT();
  const task = useQuery({ queryKey: ['task', id], queryFn: () => api.tasks.get(id) });

  if (task.isLoading) return <Spinner />;
  if (task.error || !task.data) return <ErrorBox error={task.error ?? t('Task not found')} />;
  if (!task.data.permissions.canEdit) return <Empty title={t('This task cannot be edited')}>{t('Completed tasks must be reopened first.')}</Empty>;

  return (
    <>
      <PageHeader title={t('Edit task')} subtitle={t('{project} · assigned to {name}', { project: task.data.projectName, name: task.data.assignee.name })} />
      <Card>
        <TaskForm
          task={task.data}
          submitLabel="Save changes"
          onSubmit={async (v) => {
            await api.tasks.update(id, { title: v.title, description: v.description, deadline: v.deadline, priority: v.priority });
            if (v.files.length) await uploadFiles(id, v.files);
            await qc.invalidateQueries({ queryKey: ['task', id] });
            await qc.invalidateQueries({ queryKey: ['tasks'] });
            router.push(`/tasks/${id}`);
          }}
        />
      </Card>
    </>
  );
}
