'use client';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { TaskForm } from '@/components/task-form';
import { Card, PageHeader, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { useFeedback } from '@/components/feedback';
import { uploadFiles } from '@/lib/files';
import { useT } from '@/lib/i18n';

function NewTask() {
  const router = useRouter();
  const qc = useQueryClient();
  const params = useSearchParams();
  const { t } = useT();
  const { toast } = useFeedback();
  return (
    <>
      <PageHeader title={t('New task')} subtitle={t('The employee is notified on their phone as soon as you save.')} />
      <Card>
        <TaskForm
          submitLabel="Create task"
          defaultProjectId={params.get('projectId') ?? undefined}
          onSubmit={async (v) => {
            const task = await api.tasks.create({
              projectId: v.projectId,
              departmentId: v.departmentId,
              assigneeId: v.assigneeId,
              title: v.title,
              description: v.description,
              deadline: v.deadline,
              priority: v.priority,
            });
            if (v.files.length) await uploadFiles(task.id, v.files);
            toast(t('Task created. The employee has been notified.'));
            await qc.invalidateQueries({ queryKey: ['tasks'] });
            await qc.invalidateQueries({ queryKey: ['dashboard'] });
            router.push(`/tasks/${task.id}`);
          }}
        />
      </Card>
    </>
  );
}

export default function NewTaskPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <NewTask />
    </Suspense>
  );
}
