import test from "node:test";
import assert from "node:assert/strict";
import { isActiveStaffRecord, selectPayrollStaff } from "../public/js/common.js";

// The reported bug: a "deleted" staff member kept showing up in Staff
// Attendance and in Payroll. The cause was that those screens were driven by
// the raw staff collection (and, for Attendance, by an explicit "Inactive
// staff" block) rather than by an active-staff filter. These tests pin the
// rule that replaced it, using the exact Amit / Rahul / Pankaj scenario.

const amit = { id: "amit", name: "Amit", status: "active", isActive: true, salary: 20000, salaryType: "monthly" };
const pankaj = { id: "pankaj", name: "Pankaj", status: "active", isActive: true, salary: 18000, salaryType: "monthly" };
// Rahul was deleted: the document is kept so his history survives, but he is
// no longer a current employee.
const rahul = { id: "rahul", name: "Rahul", status: "inactive", isActive: false, salary: 19000, salaryType: "monthly" };
const staff = [amit, rahul, pankaj];

const names = rows => rows.map(row => row.member.name);

test("a deleted staff member is not a current employee", () => {
  assert.equal(isActiveStaffRecord(amit), true);
  assert.equal(isActiveStaffRecord(rahul), false);
});

test("staff records created before any status field are treated as current", () => {
  // Backward compatibility: these are real employees, not deleted ones.
  assert.equal(isActiveStaffRecord({ id: "legacy", name: "Old Record" }), true);
  assert.equal(isActiveStaffRecord({}), true);
});

test("status wins over the older isActive boolean when they disagree", () => {
  assert.equal(isActiveStaffRecord({ status: "inactive", isActive: true }), false);
  assert.equal(isActiveStaffRecord({ status: "active", isActive: false }), true);
});

test("the current payroll month shows only current staff", () => {
  const rows = selectPayrollStaff({ staff, month: "2026-09", currentMonth: "2026-09" });
  assert.deepEqual(names(rows), ["Amit", "Pankaj"], "Rahul must not appear in current payroll");
});

test("a past month still shows a departed employee who has records in it", () => {
  // Historical accounting data: Rahul worked in August, so August payroll
  // must still account for him.
  const attendance = [{ staffId: "rahul", date: "2026-08-12", status: "Present" }];
  const rows = selectPayrollStaff({ staff, attendance, month: "2026-08", currentMonth: "2026-09" });
  assert.deepEqual(names(rows), ["Amit", "Pankaj", "Rahul"]);
  assert.equal(rows.find(row => row.member.name === "Rahul").historical, true, "marked historical, so the UI offers no edit/delete");
  assert.equal(rows.find(row => row.member.name === "Amit").historical, false);
});

test("an advance alone is enough to keep a departed employee on a past month", () => {
  const advances = [{ staffId: "rahul", date: "2026-08-03", amount: 2000 }];
  assert.ok(names(selectPayrollStaff({ staff, advances, month: "2026-08", currentMonth: "2026-09" })).includes("Rahul"));
});

test("a past month does NOT resurrect a departed employee who has no records in it", () => {
  const attendance = [{ staffId: "rahul", date: "2026-08-12", status: "Present" }];
  const rows = selectPayrollStaff({ staff, attendance, month: "2026-07", currentMonth: "2026-09" });
  assert.deepEqual(names(rows), ["Amit", "Pankaj"]);
});

test("a future month is treated like the current one", () => {
  const attendance = [{ staffId: "rahul", date: "2026-10-01", status: "Present" }];
  const rows = selectPayrollStaff({ staff, attendance, month: "2026-10", currentMonth: "2026-09" });
  assert.deepEqual(names(rows), ["Amit", "Pankaj"]);
});

test("re-hiring creates a separate current record and does not revive the old one", () => {
  // Adding Rahul again goes through Add Staff, producing a NEW document with a
  // new id. The old record stays inactive and keeps its own history.
  const rehired = { id: "rahul-2", name: "Rahul", status: "active", isActive: true, salary: 21000, salaryType: "monthly" };
  const rows = selectPayrollStaff({ staff: [...staff, rehired], month: "2026-09", currentMonth: "2026-09" });
  assert.deepEqual(names(rows), ["Amit", "Pankaj", "Rahul"]);
  assert.equal(rows.find(row => row.member.name === "Rahul").member.id, "rahul-2", "the new employment record, not the old one");
});

test("restoring a past staff member brings them back to current payroll", () => {
  const restored = { ...rahul, status: "active", isActive: true };
  const rows = selectPayrollStaff({ staff: [amit, restored, pankaj], month: "2026-09", currentMonth: "2026-09" });
  assert.deepEqual(names(rows), ["Amit", "Rahul", "Pankaj"]);
});
