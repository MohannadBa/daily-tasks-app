import type { ReactNode } from 'react';
import { AppShell } from '@/components/app-shell';

export default function AppLayout({ children }: { children: ReactNode }) {
  // Read at request time (not baked into the bundle): same image works in every environment.
  // Unset in AWS = same origin (wss://<domain>/api/v1/realtime via the ALB).
  return <AppShell realtimeUrl={process.env.REALTIME_PUBLIC_URL || undefined}>{children}</AppShell>;
}
