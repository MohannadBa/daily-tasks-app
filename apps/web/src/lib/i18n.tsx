'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { setFormatLocale } from './format';

import type { Locale } from './locale';
export type { Locale };
export const LOCALE_COOKIE = 'dt_locale';

/**
 * English strings are the keys; Arabic translations below. Missing keys fall back to English.
 * Placeholders use {name} syntax.
 */
const ar: Record<string, string> = {
  // shell
  Dashboard: 'لوحة التحكم',
  Projects: 'المشاريع',
  Tasks: 'المهام',
  'My tasks': 'مهامي',
  Employees: 'الموظفون',
  Team: 'الفريق',
  Notifications: 'الإشعارات',
  Settings: 'الإعدادات',
  'Sign out': 'تسجيل الخروج',
  'Open menu': 'فتح القائمة',
  'Close menu': 'إغلاق القائمة',
  Admin: 'مسؤول النظام',
  'Project manager': 'مدير مشروع',
  Employee: 'موظف',
  'Loading…': 'جارٍ التحميل…',
  // login
  'Sign in to DailyTasks': 'تسجيل الدخول إلى DailyTasks',
  'Manager portal': 'بوابة المديرين',
  Email: 'البريد الإلكتروني',
  Password: 'كلمة المرور',
  'Choose a new password': 'اختر كلمة مرور جديدة',
  'At least 8 characters with upper, lower case and a number.': '8 أحرف على الأقل تتضمن حرفاً كبيراً وصغيراً ورقماً.',
  'Set password & sign in': 'تعيين كلمة المرور وتسجيل الدخول',
  'Sign in': 'تسجيل الدخول',
  'Sign in failed': 'فشل تسجيل الدخول',
  // dashboard
  'Welcome, {name}': 'مرحباً، {name}',
  'Overview of your projects and team': 'نظرة عامة على مشاريعك وفريقك',
  'Your tasks at a glance': 'لمحة سريعة عن مهامك',
  'New task': 'مهمة جديدة',
  'Active tasks': 'المهام النشطة',
  Completed: 'مكتملة',
  Overdue: 'متأخرة',
  'Awaiting rating': 'بانتظار التقييم',
  'Upcoming deadlines': 'المواعيد النهائية القادمة',
  'View all': 'عرض الكل',
  'No open tasks': 'لا توجد مهام مفتوحة',
  'Employee performance': 'أداء الموظفين',
  Details: 'التفاصيل',
  'No employees yet': 'لا يوجد موظفون بعد',
  // task table & statuses
  Task: 'المهمة',
  Project: 'المشروع',
  Assignee: 'المكلّف',
  Deadline: 'الموعد النهائي',
  Status: 'الحالة',
  Rating: 'التقييم',
  'No tasks found': 'لا توجد مهام',
  Assigned: 'مُسندة',
  'In progress': 'قيد التنفيذ',
  'Completed late': 'مكتملة متأخرة',
  'Not rated': 'غير مُقيّم',
  // tasks page
  All: 'الكل',
  Active: 'نشطة',
  'Search tasks…': 'ابحث في المهام…',
  'All projects': 'جميع المشاريع',
  Search: 'بحث',
  '{total} tasks · page {page} of {pages}': '{total} مهمة · صفحة {page} من {pages}',
  Previous: 'السابق',
  Next: 'التالي',
  // task form
  'Select a project…': 'اختر مشروعاً…',
  'Assign to': 'إسناد إلى',
  'This project has no employees yet': 'لا يوجد موظفون في هذا المشروع بعد',
  'Select an employee…': 'اختر موظفاً…',
  Title: 'العنوان',
  Description: 'الوصف',
  'Date and time in your local timezone': 'التاريخ والوقت حسب منطقتك الزمنية',
  'Deadline must be in the future': 'يجب أن يكون الموعد النهائي في المستقبل',
  'Create task': 'إنشاء المهمة',
  'Save changes': 'حفظ التغييرات',
  'The employee is notified on their phone as soon as you save.': 'سيتلقى الموظف إشعاراً على هاتفه فور الحفظ.',
  'Edit task': 'تعديل المهمة',
  'This task cannot be edited': 'لا يمكن تعديل هذه المهمة',
  'Completed tasks must be reopened first.': 'يجب إعادة فتح المهام المكتملة أولاً.',
  '{project} · assigned to {name}': '{project} · مُسندة إلى {name}',
  'Attach files': 'إرفاق ملفات',
  'Images, PDF, Office documents · up to {size} each': 'صور وملفات PDF ومستندات Office · حتى {size} لكل ملف',
  'Remove {name}': 'إزالة {name}',
  // task detail
  'after the deadline': 'بعد الموعد النهائي',
  'No description': 'لا يوجد وصف',
  'Instructions & reference files': 'التعليمات والملفات المرجعية',
  'Replies ({n})': 'الردود ({n})',
  'Completion report': 'تقرير الإنجاز',
  'No replies yet': 'لا توجد ردود بعد',
  Reply: 'رد',
  'Complete task': 'إنهاء المهمة',
  'Describe the completed work (required)…': 'صف العمل المنجز (مطلوب)…',
  'Write a reply…': 'اكتب رداً…',
  'Completion comment': 'تعليق الإنجاز',
  'Mark as completed': 'تحديد كمكتملة',
  'Send reply': 'إرسال الرد',
  History: 'السجل',
  System: 'النظام',
  late: 'متأخرة',
  'Reopened ×{n}': 'أُعيد فتحها ×{n}',
  Edit: 'تعديل',
  Reassign: 'إعادة إسناد',
  Reopen: 'إعادة فتح',
  'Reason (recorded in history and sent to the employee)': 'السبب (يُسجّل في السجل ويُرسل إلى الموظف)',
  'New deadline': 'موعد نهائي جديد',
  'Reopen task': 'إعادة فتح المهمة',
  'New assignee': 'المكلّف الجديد',
  'Select…': 'اختر…',
  'Performance rating': 'تقييم الأداء',
  'Private · not visible to the employee': 'خاص · غير مرئي للموظف',
  'Task was completed again after this rating — review it': 'أُنجزت المهمة مجدداً بعد هذا التقييم — راجعه',
  'Rated by {name} · {date}': 'قيّمه {name} · {date}',
  'Edit rating': 'تعديل التقييم',
  'Private feedback (optional)': 'ملاحظات خاصة (اختياري)',
  'Update rating': 'تحديث التقييم',
  'Save rating': 'حفظ التقييم',
  Cancel: 'إلغاء',
  'created the task': 'أنشأ المهمة',
  'updated the task': 'حدّث المهمة',
  'changed the deadline': 'غيّر الموعد النهائي',
  'reassigned the task': 'أعاد إسناد المهمة',
  'started working': 'بدأ العمل',
  commented: 'علّق',
  'added an attachment': 'أضاف مرفقاً',
  'completed the task': 'أنجز المهمة',
  'reopened the task': 'أعاد فتح المهمة',
  'Task not found': 'المهمة غير موجودة',
  // projects
  'New project': 'مشروع جديد',
  'Create project': 'إنشاء مشروع',
  Name: 'الاسم',
  Create: 'إنشاء',
  'No projects yet': 'لا توجد مشاريع بعد',
  Archived: 'مؤرشف',
  Manager: 'مدير',
  Member: 'عضو',
  'open tasks': 'مهام مفتوحة',
  members: 'أعضاء',
  Archive: 'أرشفة',
  Unarchive: 'إلغاء الأرشفة',
  'Team ({n})': 'الفريق ({n})',
  'Add member': 'إضافة عضو',
  Role: 'الدور',
  User: 'المستخدم',
  'Select a user…': 'اختر مستخدماً…',
  Add: 'إضافة',
  'Remove {name} from {project}?': 'إزالة {name} من {project}؟',
  'Project not found': 'المشروع غير موجود',
  // employees
  'Performance ratings are private to managers and administrators.': 'تقييمات الأداء خاصة بالمديرين والمسؤولين فقط.',
  Performance: 'الأداء',
  'All my projects': 'جميع مشاريعي',
  'No employees found': 'لم يتم العثور على موظفين',
  'Average rating': 'متوسط التقييم',
  Rated: 'المُقيّمة',
  Open: 'مفتوحة',
  'ratings are private and never shown to the employee': 'التقييمات خاصة ولا تُعرض للموظف أبداً',
  'Rated tasks': 'المهام المُقيّمة',
  'Task ratings': 'تقييمات المهام',
  'No rated tasks yet': 'لا توجد مهام مُقيّمة بعد',
  'completed {date}': 'أُنجزت {date}',
  'rated by {name}': 'قيّمها {name}',
  'Rating history': 'سجل التقييمات',
  'No changes': 'لا توجد تغييرات',
  rated: 'قيّم',
  'changed rating of': 'غيّر تقييم',
  'Not found': 'غير موجود',
  // notifications
  'Mark all as read': 'تحديد الكل كمقروء',
  Unread: 'غير المقروءة',
  "You're all caught up": 'لا توجد إشعارات جديدة',
  // settings
  Profile: 'الملف الشخصي',
  Language: 'اللغة',
  'Used for the interface, push notifications and in-app messages': 'تُستخدم للواجهة والإشعارات والرسائل داخل التطبيق',
  Save: 'حفظ',
  Saved: 'تم الحفظ',
  Company: 'الشركة',
  'Company name': 'اسم الشركة',
  'Deadline reminders': 'تذكيرات المواعيد النهائية',
  'Employees get a push reminder at these times before a deadline. An overdue alert is always sent to the employee and managers. Up to 5.':
    'يتلقى الموظفون تذكيراً في هذه الأوقات قبل الموعد النهائي. يُرسل تنبيه التأخير دائماً إلى الموظف والمديرين. حتى 5 تذكيرات.',
  '{label} before': 'قبل {label}',
  '1 week': 'أسبوع',
  '3 days': '3 أيام',
  '24 hours': '24 ساعة',
  '4 hours': '4 ساعات',
  '1 hour': 'ساعة',
  '15 minutes': '15 دقيقة',
  'Save company settings': 'حفظ إعدادات الشركة',
  // users
  'Only company administrators can manage the team': 'يمكن لمسؤولي الشركة فقط إدارة الفريق',
  'Invite people and manage their company role. Add them to projects from the project page.':
    'ادعُ الأشخاص وأدر أدوارهم في الشركة. أضفهم إلى المشاريع من صفحة المشروع.',
  Members: 'الأعضاء',
  Inactive: 'غير نشط',
  Deactivate: 'تعطيل',
  Activate: 'تفعيل',
  'Invite user': 'دعوة مستخدم',
  'Full name': 'الاسم الكامل',
  'Temporary password': 'كلمة مرور مؤقتة',
  'Local/dev mode only. In production Cognito e-mails an invitation with a temporary password.':
    'لوضع التطوير المحلي فقط. في الإنتاج يرسل Cognito دعوة بكلمة مرور مؤقتة عبر البريد.',
  'Send invite': 'إرسال الدعوة',
  'Invited ✓': 'تمت الدعوة ✓',
  // mobile app shell
  Home: 'الرئيسية',
  Alerts: 'التنبيهات',
  More: 'المزيد',
  Back: 'رجوع',
  Main: 'التنقل الرئيسي',
  'Change language': 'تغيير اللغة',
  'Profile & settings': 'الملف الشخصي والإعدادات',
  'Filter by project': 'تصفية حسب المشروع',
  'Reply or complete': 'رد أو إكمال',
  'Your tasks, replies and deadlines in one place': 'مهامك وردودك ومواعيدك النهائية في مكان واحد',
  Close: 'إغلاق',
  // install (PWA)
  'Install the app': 'تثبيت التطبيق',
  'Install app': 'تثبيت التطبيق',
  'Install DailyTasks on this device': 'ثبّت DailyTasks على هذا الجهاز',
  'Open it from your Home Screen like an app and get task alerts.': 'افتحه من الشاشة الرئيسية كأي تطبيق واحصل على تنبيهات المهام.',
  'Not now': 'ليس الآن',
  'Show me how': 'أرني الطريقة',
  'Hide steps': 'إخفاء الخطوات',
  'DailyTasks is installed and running as an app on this device.': 'تم تثبيت DailyTasks ويعمل كتطبيق على هذا الجهاز.',
  'Add DailyTasks to your Home Screen to open it full-screen, like a native app.': 'أضف DailyTasks إلى الشاشة الرئيسية لفتحه بملء الشاشة كتطبيق أصلي.',
  'iPhone & iPad (Safari)': 'آيفون وآيباد (Safari)',
  'Android (Chrome)': 'أندرويد (Chrome)',
  'Open this page in Safari (installing works from Safari on iPhone and iPad).': 'افتح هذه الصفحة في Safari (التثبيت يتم من Safari على آيفون وآيباد).',
  'Then tap Share and choose Add to Home Screen.': 'ثم اضغط على مشاركة واختر «إضافة إلى الشاشة الرئيسية».',
  'Tap the Share button': 'اضغط على زر المشاركة',
  'in the Safari toolbar.': 'في شريط أدوات Safari.',
  'Scroll down and tap Add to Home Screen': 'مرّر للأسفل واضغط «إضافة إلى الشاشة الرئيسية»',
  'Tap Add. Open DailyTasks from your Home Screen.': 'اضغط «إضافة»، ثم افتح DailyTasks من الشاشة الرئيسية.',
  'Open the browser menu': 'افتح قائمة المتصفح',
  'Tap Install app (or Add to Home screen).': 'اضغط «تثبيت التطبيق» (أو «إضافة إلى الشاشة الرئيسية»).',
  'Confirm. DailyTasks opens like a regular app.': 'أكّد. سيفتح DailyTasks كتطبيق عادي.',
};

const dictionaries: Record<Locale, Record<string, string>> = { en: {}, ar };

export function translate(locale: Locale, key: string, vars?: Record<string, string | number>): string {
  let s = dictionaries[locale][key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

interface I18nValue {
  locale: Locale;
  dir: 'ltr' | 'rtl';
  t: (key: string, vars?: Record<string, string | number>) => string;
  setLocale: (l: Locale) => void;
}

const I18nContext = createContext<I18nValue | null>(null);
const fallback: I18nValue = { locale: 'en', dir: 'ltr', t: (key, vars) => translate('en', key, vars), setLocale: () => {} };

export function I18nProvider({ initialLocale, children }: { initialLocale: Locale; children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  setFormatLocale(locale);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr';
  }, [locale]);

  const setLocale = useCallback((l: Locale) => {
    // Readable by the server layout so the first render already has the right lang/dir.
    document.cookie = `${LOCALE_COOKIE}=${l}; path=/; max-age=31536000; samesite=lax`;
    setLocaleState(l);
  }, []);

  const value = useMemo<I18nValue>(
    () => ({ locale, dir: locale === 'ar' ? 'rtl' : 'ltr', setLocale, t: (key, vars) => translate(locale, key, vars) }),
    [locale, setLocale],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useT(): I18nValue {
  // Outside the provider (e.g. isolated component tests) fall back to English.
  return useContext(I18nContext) ?? fallback;
}
