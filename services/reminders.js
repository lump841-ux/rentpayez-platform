'use strict';
// Pure, dependency-free logic for the in-app rent-due reminder, shared
// between the staff summary (routes/orgs.js GET /rent-reminders) and the
// tenant dashboard banner (routes/tenant.js GET /me) so both sides always
// agree on what "due soon" / "overdue" means. No email/SMS is sent — this
// is computed purely from unit.rent_due_day and whether a payment already
// exists for the current calendar month, entirely in-app.
//
// Kept as a plain function (not a class, no DB access) specifically so it
// can be unit-tested directly against fixed dates without touching the DB.
function rentReminderStatus(dueDay, paidThisPeriod, today = new Date()) {
  if (!dueDay) return { dueDay: null, status: 'no_due_day', daysUntilDue: null };
  if (paidThisPeriod) return { dueDay, status: 'paid', daysUntilDue: null };
  const day = today.getDate();
  const daysUntilDue = dueDay - day;
  if (daysUntilDue < 0) return { dueDay, status: 'overdue', daysUntilDue };
  if (daysUntilDue <= 5) return { dueDay, status: 'due_soon', daysUntilDue };
  return { dueDay, status: 'upcoming', daysUntilDue };
}

module.exports = { rentReminderStatus };
