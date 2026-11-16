'use client';
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { REALTIME_PATH, type RealtimeEvent } from '@dailytasks/shared-types';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { RealtimeClient, resolveRealtimeUrl, type RealtimeStatus } from '@/lib/realtime';
import { useFeedback } from './feedback';

const StatusContext = createContext<RealtimeStatus>('closed');
export const useRealtimeStatus = () => useContext(StatusContext);

const toastText: Partial<Record<RealtimeEvent['type'], string>> = {
  TASK_ASSIGNED: 'A new task was assigned to you',
  TASK_REASSIGNED: 'A task assignment changed',
  TASK_COMMENT_ADDED: 'New reply on a task',
  TASK_COMPLETED: 'A task was completed',
  TASK_REOPENED: 'A task was reopened',
  TASK_OVERDUE: 'A task is overdue',
  TASK_DEADLINE_APPROACHING: 'A deadline is approaching',
};

/**
 * Keeps the open app in sync: on every event, refetch what it affects (notification count,
 * dashboard, task lists, the task itself). Web Push covers users who are away.
 */
export function RealtimeConnector({ url, children }: { url?: string; children: ReactNode }) {
  const qc = useQueryClient();
  const { toast } = useFeedback();
  const { t } = useT();
  const [status, setStatus] = useState<RealtimeStatus>('closed');

  useEffect(() => {
    if (typeof WebSocket === 'undefined') return;
    const client = new RealtimeClient({
      url: resolveRealtimeUrl(url, window.location, REALTIME_PATH),
      onStatus: setStatus,
      refreshSession: async () => {
        try {
          await api.auth.me(); // the BFF refreshes the session cookie when needed
          return true;
        } catch {
          return false;
        }
      },
      onEvent: (e) => {
        void qc.invalidateQueries({ queryKey: ['notifications'] });
        void qc.invalidateQueries({ queryKey: ['dashboard'] });
        void qc.invalidateQueries({ queryKey: ['tasks'] });
        if (e.taskId) for (const k of ['task', 'comments', 'history']) void qc.invalidateQueries({ queryKey: [k, e.taskId] });
        if (e.projectId) void qc.invalidateQueries({ queryKey: ['project', e.projectId] });
        const text = toastText[e.type];
        if (text && document.visibilityState === 'visible') toast(t(text), 'info');
      },
    });
    client.start();
    const nudge = () => document.visibilityState === 'visible' && client.nudge();
    window.addEventListener('online', nudge);
    document.addEventListener('visibilitychange', nudge);
    return () => {
      window.removeEventListener('online', nudge);
      document.removeEventListener('visibilitychange', nudge);
      client.stop();
    };
  }, [url, qc, toast, t]);

  return <StatusContext.Provider value={status}>{children}</StatusContext.Provider>;
}
