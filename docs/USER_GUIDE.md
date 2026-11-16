# Al-Rasiyat — User guide · دليل الاستخدام

The app opens in Arabic (switch to English from the sidebar or the “More” menu; the choice is remembered and the current page stays open). All times are Riyadh time. On phones, install it from the browser (“Add to Home Screen”) and enable notifications in **Notification settings**.

## Everyone
| Screen | What you can do |
|---|---|
| **Dashboard** | Your numbers at a glance (different for admins, managers and employees). Personal-task counts are shown separately and never count towards company performance. |
| **Tasks** | Search, filter (project, department, priority, status views), sort and page through the tasks you can see. |
| **Task page** | Details (department, priority, approver, who assigned it), replies with files, the full history, **Submissions & decisions**, **Transfers** (with the current delegation chain), **Deadline extensions**, and **Time accounting**. |
| **Personal tasks** | A private to-do list: create, edit, set a due date and priority, complete, reopen, search, delete. Nobody else can see it — not managers, not administrators. |
| **Documents** | Files of each project you belong to: grid or list, search, filter by category/source, sort, preview images/PDF, download. |
| **Reports** | PDF reports (Arabic or English) generated on the server; private to you; kept 7 days. |
| **Notifications** | Every event, read/unread, with links to the task or page. Live updates arrive instantly while the app is open; Web Push covers the rest. |
| **Settings** | Name, language, change password, install the app. |

## Who sees which tasks
* **Project managers** see only the tasks they created or approve. Two managers of the same project don't see each other's tasks, ratings or task deliverables.
* **The system admin** sees only tasks he created or that a manager assigned to him. He keeps account, department and project administration. To receive tasks he must be added to the project (as employee) and to a department.
* **Employees** see the tasks assigned to them (and tasks transferred to/through them).

## Employees
1. Open the task and press **Start task** (or simply reply).
2. Reply and attach photos/files as you work.
3. When done, choose **Submit completion**, describe the work (required) and attach files → **Submit for approval**. The task shows **Pending approval** and your clock pauses.
4. If the manager rejects (or a colleague returns) your work, the task shows the reason in red; continue and submit again. Such tasks are listed under **Tasks → Sent back to me**.
5. **Transfer to a colleague**: choose an eligible colleague (same project and department), give a reason and confirm. You stay responsible until they accept. When they submit, it appears in **your Review inbox**: forward it to the manager or return it with a reason.
6. **Incoming transfers**: accept, or decline with a reason.
7. **Request more time**: enter extra hours and a reason; the manager approves fully, partially or rejects. The original deadline is always kept.

## Project managers
* **New task**: choose project, then department — the employee list only shows employees of that project *and* department — then title, description, priority, deadline and files.
* **Review inbox**: every submission waiting for you with employee, department, project, submission time, comment, files, accountable time and deadlines. **Approve** completes the task; **Reject** needs a reason and sends the task back. The task page keeps every submission and decision.
* **Time accounting** (task page): accountable time vs. time allowed, time per responsible employee, manager review (paused, excluded when approved, charged when rejected), completion duration, overdue duration, original and approved deadlines. While a decision is pending the numbers are marked **provisional**; after approval they are **final**.
* **Extensions**: decide from the task page (approve, approve a shorter duration, or reject with a reason).
* **Projects → Documents**: upload (choose category and visibility: everyone or managers only), archive. Approved deliverables appear automatically (managers only by default).
* **Employees**: profile with departments, projects, active/pending/completed tasks and the private performance summary (ratings are never shown to employees).
* **Reports**: task, employee (date range, projects, department, status, priority, on-time/late) and projects reports.

## Administrators
* **Departments**: create (code + Arabic and English names), rename, activate/deactivate, view members and change an employee’s departments (one primary).
* **Administration**: create employees/managers with departments and projects; a temporary password is shown **once** (or e-mailed by Cognito in production) with onboarding instructions. Change roles, add to projects, reset passwords, activate/deactivate, and view each account’s history.
* At first sign-in the user must choose a new password before anything else.
* The review inbox can show all pending approvals in the company; deciding instead of the approver requires a reason and is audited.
