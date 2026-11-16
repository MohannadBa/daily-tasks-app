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
  'Sign in to Al-Rasiyat': 'تسجيل الدخول إلى الراسيات',
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
  'Install Al-Rasiyat on this device': 'ثبّت الراسيات على هذا الجهاز',
  'Open it from your Home Screen like an app and get task alerts.': 'افتحه من الشاشة الرئيسية كأي تطبيق واحصل على تنبيهات المهام.',
  'Not now': 'ليس الآن',
  'Show me how': 'أرني الطريقة',
  'Hide steps': 'إخفاء الخطوات',
  'Al-Rasiyat is installed and running as an app on this device.': 'تم تثبيت الراسيات ويعمل كتطبيق على هذا الجهاز.',
  'Add Al-Rasiyat to your Home Screen to open it full-screen, like a native app.': 'أضف الراسيات إلى الشاشة الرئيسية لفتحه بملء الشاشة كتطبيق أصلي.',
  'iPhone & iPad (Safari)': 'آيفون وآيباد (Safari)',
  'Android (Chrome)': 'أندرويد (Chrome)',
  'Open this page in Safari (installing works from Safari on iPhone and iPad).': 'افتح هذه الصفحة في Safari (التثبيت يتم من Safari على آيفون وآيباد).',
  'Then tap Share and choose Add to Home Screen.': 'ثم اضغط على مشاركة واختر «إضافة إلى الشاشة الرئيسية».',
  'Tap the Share button': 'اضغط على زر المشاركة',
  'in the Safari toolbar.': 'في شريط أدوات Safari.',
  'Scroll down and tap Add to Home Screen': 'مرّر للأسفل واضغط «إضافة إلى الشاشة الرئيسية»',
  'Tap Add. Open Al-Rasiyat from your Home Screen.': 'اضغط «إضافة»، ثم افتح الراسيات من الشاشة الرئيسية.',
  'Open the browser menu': 'افتح قائمة المتصفح',
  'Tap Install app (or Add to Home screen).': 'اضغط «تثبيت التطبيق» (أو «إضافة إلى الشاشة الرئيسية»).',
  'Confirm. Al-Rasiyat opens like a regular app.': 'أكّد. سيفتح الراسيات كتطبيق عادي.',
  // push notification settings
  'Notification settings': 'إعدادات الإشعارات',
  'Push notifications': 'الإشعارات الفورية',
  'Get task alerts on your phone even when Al-Rasiyat is closed.': 'احصل على تنبيهات المهام على هاتفك حتى عندما يكون الراسيات مغلقاً.',
  'Get task alerts on this phone or computer, even when Al-Rasiyat is closed.': 'احصل على تنبيهات المهام على هذا الهاتف أو الحاسوب حتى عندما يكون الراسيات مغلقاً.',
  'Notifications are blocked for Al-Rasiyat': 'الإشعارات محظورة لتطبيق الراسيات',
  'The browser will not ask again. Turn them back on in your device settings, then return here:': 'لن يطلب المتصفح الإذن مرة أخرى. فعّلها من إعدادات جهازك ثم عد إلى هنا:',
  'iPhone / iPad': 'آيفون / آيباد',
  'Settings → Notifications → Al-Rasiyat → Allow Notifications.': 'الإعدادات ← الإشعارات ← الراسيات ← السماح بالإشعارات.',
  Android: 'أندرويد',
  'Long-press the Al-Rasiyat icon → App info → Notifications → Allow. In Chrome: ⋮ → Settings → Site settings → Notifications.':
    'اضغط مطولاً على أيقونة الراسيات ← معلومات التطبيق ← الإشعارات ← سماح. في Chrome: ⋮ ← الإعدادات ← إعدادات المواقع ← الإشعارات.',
  Computer: 'الحاسوب',
  'Click the icon left of the address bar → Notifications → Allow, then reload the page.': 'انقر الأيقونة بجانب شريط العنوان ← الإشعارات ← سماح، ثم أعد تحميل الصفحة.',
  Allowed: 'مسموح',
  Blocked: 'محظور',
  'Not asked yet': 'لم يُطلب بعد',
  'Not supported': 'غير مدعوم',
  'This device': 'هذا الجهاز',
  'Added {when}': 'أضيف {when}',
  'last notification {when}': 'آخر إشعار {when}',
  'Stopped: {reason}': 'متوقف: {reason}',
  'Last delivery': 'آخر إرسال',
  'accepted by push service': 'قبلته خدمة الإشعارات',
  retrying: 'جارٍ إعادة المحاولة',
  'subscription expired': 'انتهى الاشتراك',
  failed: 'فشل',
  'Permission was not granted. Tap Enable notifications again and choose Allow.': 'لم يتم منح الإذن. اضغط «تفعيل الإشعارات» مرة أخرى واختر «سماح».',
  'Push notifications are not configured on the server yet.': 'لم يتم إعداد الإشعارات الفورية على الخادم بعد.',
  'Add Al-Rasiyat to your Home Screen first, then open it from there.': 'أضف الراسيات إلى الشاشة الرئيسية أولاً، ثم افتحه من هناك.',
  'This browser does not support push notifications.': 'هذا المتصفح لا يدعم الإشعارات الفورية.',
  'Could not turn on notifications: {msg}': 'تعذّر تفعيل الإشعارات: {msg}',
  'Push is turned off on the server': 'الإشعارات الفورية متوقفة على الخادم',
  'An administrator needs to configure Web Push (VAPID keys). In-app notifications still work.': 'يجب على المسؤول إعداد Web Push (مفاتيح VAPID). الإشعارات داخل التطبيق ما زالت تعمل.',
  'Install the app to get notifications on iPhone': 'ثبّت التطبيق لتلقي الإشعارات على آيفون',
  'On iPhone and iPad, notifications only work in the Al-Rasiyat app on your Home Screen (iOS 16.4 or later), not in a Safari tab.':
    'على آيفون وآيباد تعمل الإشعارات فقط في تطبيق الراسيات على الشاشة الرئيسية (iOS 16.4 أو أحدث)، وليس في تبويب Safari.',
  'Then open Al-Rasiyat from the Home Screen and come back to this page.': 'ثم افتح الراسيات من الشاشة الرئيسية وعد إلى هذه الصفحة.',
  'This browser cannot receive push notifications': 'هذا المتصفح لا يستطيع استقبال الإشعارات الفورية',
  'Push requires a secure (https) connection.': 'تتطلب الإشعارات الفورية اتصالاً آمناً (https).',
  'Use Chrome on Android, Safari on iPhone (installed app), or a current desktop browser.': 'استخدم Chrome على أندرويد، أو Safari على آيفون (التطبيق المثبّت)، أو متصفح حاسوب حديث.',
  'Opened as installed app': 'مفتوح كتطبيق مثبّت',
  'Push supported by this browser': 'المتصفح يدعم الإشعارات الفورية',
  'Notification permission': 'إذن الإشعارات',
  'Subscription on this device': 'الاشتراك على هذا الجهاز',
  'Needs re-enabling': 'يحتاج إلى إعادة التفعيل',
  Off: 'متوقف',
  Yes: 'نعم',
  No: 'لا',
  'Enable notifications': 'تفعيل الإشعارات',
  'Send test notification': 'إرسال إشعار تجريبي',
  'Turn off on this device': 'إيقاف على هذا الجهاز',
  'Test notification queued': 'تمت جدولة الإشعار التجريبي',
  'It usually arrives within seconds, but Apple and Google decide the exact delivery time. "Accepted by push service" below means it left our server — not that your phone showed it.':
    'يصل عادةً خلال ثوانٍ، لكن Apple وGoogle تحددان وقت التسليم الفعلي. عبارة «قبلته خدمة الإشعارات» تعني أنه غادر خادمنا، وليس أن هاتفك عرضه.',
  'Nothing appeared? Check Focus / Do Not Disturb, that notifications for Al-Rasiyat are allowed in system settings, and that the phone is online.':
    'لم يظهر شيء؟ تحقّق من وضع التركيز / عدم الإزعاج، ومن السماح بإشعارات الراسيات في إعدادات النظام، ومن اتصال الهاتف بالإنترنت.',
  'Your devices ({n})': 'أجهزتك ({n})',
  'No devices receive notifications yet.': 'لا توجد أجهزة تستقبل الإشعارات بعد.',
  'Each phone, browser or installed app is a separate device. Signing out removes this device.': 'كل هاتف أو متصفح أو تطبيق مثبّت يُعد جهازاً منفصلاً. تسجيل الخروج يزيل هذا الجهاز.',
  'How to set up': 'طريقة الإعداد',
  'iPhone & iPad (iOS 16.4+)': 'آيفون وآيباد (iOS 16.4 أو أحدث)',
  'Open Al-Rasiyat from the Home Screen → Notification settings → Enable notifications → Allow.': 'افتح الراسيات من الشاشة الرئيسية ← إعدادات الإشعارات ← تفعيل الإشعارات ← سماح.',
  'Open Al-Rasiyat → Notification settings → Enable notifications → Allow.': 'افتح الراسيات ← إعدادات الإشعارات ← تفعيل الإشعارات ← سماح.',
  'Enabling notifications': 'تفعيل الإشعارات',
  'We only ask for permission when you tap Enable notifications.': 'نطلب الإذن فقط عندما تضغط «تفعيل الإشعارات».',
  'Enable it on every device you use; each one is listed above.': 'فعّلها على كل جهاز تستخدمه؛ كل جهاز يظهر في القائمة أعلاه.',
  'Use Send test notification to check this device.': 'استخدم «إرسال إشعار تجريبي» لاختبار هذا الجهاز.',
  'Delivery depends on Apple/Google and the phone being online; timing is not guaranteed.': 'يعتمد التسليم على Apple/Google وعلى اتصال الهاتف؛ التوقيت غير مضمون.',
  // brand & auth
  'Al-Rasiyat': 'الراسيات',
  'Every task, reply and deadline — in one place.': 'كل مهمة وردّ وموعد نهائي — في مكان واحد.',
  'Assign work, follow progress and get notified the moment something changes.': 'أسند المهام وتابع التقدّم واحصل على إشعار فور حدوث أي تغيير.',
  'Forgot password?': 'نسيت كلمة المرور؟',
  'Reset your password': 'إعادة تعيين كلمة المرور',
  'We will e-mail you a verification code.': 'سنرسل لك رمز تحقق عبر البريد الإلكتروني.',
  'Enter the code from the e-mail and choose a new password.': 'أدخل الرمز المرسل إلى بريدك واختر كلمة مرور جديدة.',
  'If an account exists for {email}, a code is on its way.': 'إذا كان هناك حساب مرتبط بـ {email} فسيصلك الرمز قريباً.',
  'Verification code': 'رمز التحقق',
  'New password': 'كلمة المرور الجديدة',
  'Send code': 'إرسال الرمز',
  'Change password': 'تغيير كلمة المرور',
  'Back to sign in': 'العودة إلى تسجيل الدخول',
  'Password changed. Sign in with your new password.': 'تم تغيير كلمة المرور. سجّل الدخول بكلمة المرور الجديدة.',
  'Password reset by e-mail is not available on this server. Ask an administrator to reset your password.':
    'استعادة كلمة المرور عبر البريد غير متاحة على هذا الخادم. اطلب من المسؤول إعادة تعيين كلمة مرورك.',
  // feedback & dialogs
  Confirm: 'تأكيد',
  Remove: 'إزالة',
  Removed: 'أُزيل',
  'Reply sent': 'تم إرسال الرد',
  'Task completed': 'تم إنجاز المهمة',
  'Task reopened': 'أُعيد فتح المهمة',
  'Task reassigned': 'أُعيد إسناد المهمة',
  'Rating saved': 'تم حفظ التقييم',
  'Task created. The employee has been notified.': 'تم إنشاء المهمة وإشعار الموظف.',
  'Uploading {name}': 'جارٍ رفع {name}',
  // dashboard
  'Due within 24 hours': 'تستحق خلال 24 ساعة',
  'My open tasks': 'مهامي المفتوحة',
  'Recent activity': 'النشاط الأخير',
  'No activity yet': 'لا يوجد نشاط بعد',
  // tasks
  'Sort by': 'ترتيب حسب',
  'Sort: default': 'الترتيب: افتراضي',
  'Deadline: soonest first': 'الموعد النهائي: الأقرب أولاً',
  'Deadline: latest first': 'الموعد النهائي: الأبعد أولاً',
  'Newest first': 'الأحدث أولاً',
  'Recently updated': 'المحدّثة مؤخراً',
  'Title A–Z': 'العنوان أ–ي',
  // projects
  'Edit project': 'تعديل المشروع',
  'Project saved': 'تم حفظ المشروع',
  'Project archived': 'تمت أرشفة المشروع',
  'Project restored': 'تمت استعادة المشروع',
  'Archive {project}?': 'أرشفة {project}؟',
  'Archived projects are read-only and hidden from task creation.': 'المشاريع المؤرشفة للقراءة فقط ولا تظهر عند إنشاء المهام.',
  'Member added': 'تمت إضافة العضو',
  'Member removed': 'تمت إزالة العضو',
  'They lose access to this project immediately. Their tasks and history are kept.': 'سيفقد الوصول إلى هذا المشروع فوراً، مع الاحتفاظ بمهامه وسجلّه.',
  // employees & team
  'Open tasks ({n})': 'المهام المفتوحة ({n})',
  'No projects': 'لا توجد مشاريع',
  'Invitation sent': 'تم إرسال الدعوة',
  'Reset password': 'إعادة تعيين كلمة المرور',
  'Reset password for {name}': 'إعادة تعيين كلمة مرور {name}',
  'A reset code was e-mailed to the user.': 'تم إرسال رمز إعادة التعيين إلى بريد المستخدم.',
  'Temporary password set.': 'تم تعيين كلمة مرور مؤقتة.',
  'Temporary password (local mode only)': 'كلمة مرور مؤقتة (الوضع المحلي فقط)',
  'With Cognito the user receives a reset code by e-mail and chooses a new password on the "Forgot password" page. In local mode, set a temporary password.':
    'مع Cognito يستلم المستخدم رمزاً عبر البريد ويختار كلمة مرور جديدة من صفحة «نسيت كلمة المرور». في الوضع المحلي عيّن كلمة مرور مؤقتة.',
  'Deactivate {name}?': 'إيقاف {name}؟',
  'They are signed out everywhere and can no longer sign in. Their history is kept.': 'سيتم تسجيل خروجه من كل الأجهزة ولن يتمكن من الدخول، مع الاحتفاظ بسجلّه.',
  // real-time
  Live: 'مباشر',
  Offline: 'غير متصل',
  'Live updates on': 'التحديثات المباشرة مفعّلة',
  'Reconnecting…': 'جارٍ إعادة الاتصال…',
  'A new task was assigned to you': 'تم إسناد مهمة جديدة إليك',
  'A task assignment changed': 'تغيّر إسناد إحدى المهام',
  'New reply on a task': 'رد جديد على مهمة',
  'A task was completed': 'تم إنجاز مهمة',
  'A task was reopened': 'أُعيد فتح مهمة',
  'A task is overdue': 'مهمة متأخرة',
  'A deadline is approaching': 'موعد نهائي يقترب',
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
