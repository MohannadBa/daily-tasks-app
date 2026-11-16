import type { NotificationType } from '@dailytasks/database';

type Locale = 'en' | 'ar';
interface Vars {
  title: string;
  project: string;
  actor?: string;
  hours?: string;
  reassignedAway?: boolean;
}

const fmtHours = (minutes: number, locale: Locale) => {
  if (minutes % 1440 === 0) {
    const d = minutes / 1440;
    return locale === 'ar' ? `${d} يوم` : `${d} day${d > 1 ? 's' : ''}`;
  }
  if (minutes % 60 === 0) {
    const h = minutes / 60;
    return locale === 'ar' ? `${h} ساعة` : `${h} hour${h > 1 ? 's' : ''}`;
  }
  return locale === 'ar' ? `${minutes} دقيقة` : `${minutes} minutes`;
};
export { fmtHours };

const templates: Record<Locale, Record<NotificationType, (v: Vars) => { title: string; body: string }>> = {
  en: {
    TASK_ASSIGNED: (v) => ({ title: 'New task assigned', body: `${v.title} · ${v.project}` }),
    TASK_UPDATED: (v) => ({ title: 'Task updated', body: `${v.actor ?? 'A manager'} updated "${v.title}"` }),
    TASK_REASSIGNED: (v) =>
      v.reassignedAway
        ? { title: 'Task reassigned', body: `"${v.title}" was reassigned to another employee` }
        : { title: 'Task assigned to you', body: `${v.title} · ${v.project}` },
    TASK_COMMENT_ADDED: (v) => ({ title: 'New reply', body: `${v.actor ?? 'Someone'} commented on "${v.title}"` }),
    TASK_COMPLETED: (v) => ({ title: 'Task completed', body: `${v.actor ?? 'An employee'} completed "${v.title}"` }),
    TASK_OVERDUE: (v) => ({ title: 'Task overdue', body: `"${v.title}" passed its deadline` }),
    TASK_DEADLINE_APPROACHING: (v) => ({ title: 'Deadline approaching', body: `"${v.title}" is due in ${v.hours}` }),
    TASK_REOPENED: (v) => ({ title: 'Task reopened', body: `"${v.title}" was reopened by ${v.actor ?? 'a manager'}` }),
  },
  ar: {
    TASK_ASSIGNED: (v) => ({ title: 'مهمة جديدة', body: `${v.title} · ${v.project}` }),
    TASK_UPDATED: (v) => ({ title: 'تم تحديث المهمة', body: `قام ${v.actor ?? 'المدير'} بتحديث "${v.title}"` }),
    TASK_REASSIGNED: (v) =>
      v.reassignedAway
        ? { title: 'تمت إعادة إسناد المهمة', body: `تم إسناد "${v.title}" إلى موظف آخر` }
        : { title: 'تم إسناد مهمة إليك', body: `${v.title} · ${v.project}` },
    TASK_COMMENT_ADDED: (v) => ({ title: 'رد جديد', body: `علّق ${v.actor ?? 'أحدهم'} على "${v.title}"` }),
    TASK_COMPLETED: (v) => ({ title: 'تم إنجاز المهمة', body: `أنجز ${v.actor ?? 'الموظف'} "${v.title}"` }),
    TASK_OVERDUE: (v) => ({ title: 'مهمة متأخرة', body: `تجاوزت "${v.title}" موعدها النهائي` }),
    TASK_DEADLINE_APPROACHING: (v) => ({ title: 'اقتراب الموعد النهائي', body: `موعد "${v.title}" بعد ${v.hours}` }),
    TASK_REOPENED: (v) => ({ title: 'أعيد فتح المهمة', body: `أعاد ${v.actor ?? 'المدير'} فتح "${v.title}"` }),
  },
};

export function render(type: NotificationType, locale: string, vars: Vars) {
  const l: Locale = locale === 'ar' ? 'ar' : 'en';
  return templates[l][type](vars);
}
