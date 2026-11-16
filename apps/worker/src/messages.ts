import type { NotificationType } from '@dailytasks/database';

type Locale = 'en' | 'ar';
interface Vars {
  title: string;
  project: string;
  actor?: string;
  hours?: string;
  reassignedAway?: boolean;
  /** Short reason/note (rejection, transfer, extension). */
  reason?: string;
  /** Extension minutes (requested or granted) or document count. */
  minutes?: number;
  /** Subject name (new user, document title). */
  name?: string;
}

const why = (v: Vars, sep: string) => (v.reason ? `${sep}${v.reason}` : '');

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
    PUSH_TEST: () => ({ title: 'Test notification', body: 'Notifications are working on this device.' }),
    TASK_SUBMITTED: (v) => ({ title: 'Work submitted for review', body: `${v.actor ?? 'An employee'} submitted "${v.title}"` }),
    TASK_SUBMISSION_FORWARDED: (v) => ({ title: 'Work forwarded for approval', body: `${v.actor ?? 'A colleague'} forwarded "${v.title}"` }),
    TASK_APPROVED: (v) =>
      v.reason === 'admin'
        ? { title: 'Task approved by an administrator', body: `"${v.title}" was approved by ${v.actor ?? 'an administrator'} on your behalf` }
        : { title: 'Task approved', body: `"${v.title}" was approved` },
    TASK_REJECTED: (v) => ({ title: 'Submission rejected', body: `"${v.title}" needs more work${why(v, ': ')}` }),
    TASK_RETURNED: (v) => ({ title: 'Work returned to you', body: `${v.actor ?? 'Your colleague'} returned "${v.title}"${why(v, ': ')}` }),
    TASK_TRANSFER_REQUESTED: (v) => ({ title: 'Task transfer request', body: `${v.actor ?? 'A colleague'} wants to transfer "${v.title}" to you${why(v, ': ')}` }),
    TASK_TRANSFER_ACCEPTED: (v) => ({ title: 'Transfer accepted', body: `${v.actor ?? 'Your colleague'} accepted "${v.title}"` }),
    TASK_TRANSFER_DECLINED: (v) => ({ title: 'Transfer declined', body: `${v.actor ?? 'Your colleague'} declined "${v.title}"${why(v, ': ')}` }),
    TASK_EXTENSION_REQUESTED: (v) => ({
      title: 'Extension requested',
      body: `${v.actor ?? 'An employee'} asks for ${v.minutes ? fmtHours(v.minutes, 'en') : 'more time'} on "${v.title}"${why(v, ': ')}`,
    }),
    TASK_EXTENSION_DECIDED: (v) =>
      v.minutes
        ? { title: 'Extension approved', body: `"${v.title}" got ${fmtHours(v.minutes, 'en')} more${why(v, ' — ')}` }
        : { title: 'Extension rejected', body: `More time for "${v.title}" was not approved${why(v, ': ')}` },
    DOCUMENT_REGISTERED: (v) => ({ title: 'New project document', body: v.name ? `"${v.name}" was added to ${v.project || 'the project'}` : `Files from "${v.title}" were added to the project documents` }),
    USER_CREATED: (v) => ({ title: 'New account created', body: `${v.actor ?? 'An administrator'} created an account for ${v.name ?? 'a new user'}` }),
    PASSWORD_CHANGE_REQUIRED: () => ({ title: 'Password reset', body: 'Your password was reset. Choose a new one at your next sign-in.' }),
    REPORT_READY: () => ({ title: 'Report ready', body: 'Your PDF report is ready to download.' }),
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
    PUSH_TEST: () => ({ title: 'إشعار تجريبي', body: 'الإشعارات تعمل على هذا الجهاز.' }),
    TASK_SUBMITTED: (v) => ({ title: 'تسليم عمل للمراجعة', body: `سلّم ${v.actor ?? 'الموظف'} "${v.title}"` }),
    TASK_SUBMISSION_FORWARDED: (v) => ({ title: 'إحالة عمل للاعتماد', body: `أحال ${v.actor ?? 'الزميل'} "${v.title}" للاعتماد` }),
    TASK_APPROVED: (v) =>
      v.reason === 'admin'
        ? { title: 'اعتماد من مسؤول النظام', body: `اعتمد ${v.actor ?? 'مسؤول النظام'} "${v.title}" نيابةً عنك` }
        : { title: 'تم اعتماد المهمة', body: `تم اعتماد "${v.title}"` },
    TASK_REJECTED: (v) => ({ title: 'تم رفض التسليم', body: `تحتاج "${v.title}" إلى استكمال${why(v, ': ')}` }),
    TASK_RETURNED: (v) => ({ title: 'أعيد العمل إليك', body: `أعاد ${v.actor ?? 'الزميل'} "${v.title}"${why(v, ': ')}` }),
    TASK_TRANSFER_REQUESTED: (v) => ({ title: 'طلب تحويل مهمة', body: `يرغب ${v.actor ?? 'زميل'} في تحويل "${v.title}" إليك${why(v, ': ')}` }),
    TASK_TRANSFER_ACCEPTED: (v) => ({ title: 'تم قبول التحويل', body: `قبل ${v.actor ?? 'الزميل'} مهمة "${v.title}"` }),
    TASK_TRANSFER_DECLINED: (v) => ({ title: 'تم الاعتذار عن التحويل', body: `اعتذر ${v.actor ?? 'الزميل'} عن "${v.title}"${why(v, ': ')}` }),
    TASK_EXTENSION_REQUESTED: (v) => ({
      title: 'طلب تمديد',
      body: `يطلب ${v.actor ?? 'الموظف'} تمديد "${v.title}" ${v.minutes ? fmtHours(v.minutes, 'ar') : ''}${why(v, ': ')}`,
    }),
    TASK_EXTENSION_DECIDED: (v) =>
      v.minutes
        ? { title: 'تمت الموافقة على التمديد', body: `مُددت "${v.title}" ${fmtHours(v.minutes, 'ar')}${why(v, ' — ')}` }
        : { title: 'تم رفض التمديد', body: `لم تتم الموافقة على تمديد "${v.title}"${why(v, ': ')}` },
    DOCUMENT_REGISTERED: (v) => ({ title: 'مستند جديد في المشروع', body: v.name ? `أضيف "${v.name}" إلى ${v.project || 'المشروع'}` : `أضيفت ملفات "${v.title}" إلى مستندات المشروع` }),
    USER_CREATED: (v) => ({ title: 'حساب جديد', body: `أنشأ ${v.actor ?? 'مسؤول النظام'} حساباً لـ ${v.name ?? 'مستخدم جديد'}` }),
    PASSWORD_CHANGE_REQUIRED: () => ({ title: 'إعادة تعيين كلمة المرور', body: 'أعيد تعيين كلمة المرور. اختر كلمة جديدة عند تسجيل الدخول القادم.' }),
    REPORT_READY: () => ({ title: 'التقرير جاهز', body: 'تقرير PDF جاهز للتنزيل.' }),
  },
};

export function render(type: NotificationType, locale: string, vars: Vars) {
  const l: Locale = locale === 'ar' ? 'ar' : 'en';
  return templates[l][type](vars);
}
