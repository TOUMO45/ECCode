'use strict';
const { json, problem, readJson, validate } = require('../../vendor/acme-kit/http');
const money = require('../../vendor/acme-kit/money');
const repo = require('./repository');
const members = require('../members/repository');
const { dueDateFor, lateness, viewLoan } = require('./service');
const { localDay } = require('../lib/dates');
const { record } = require('../lib/audit');
const { parsePage } = require('../lib/paging');
const cfg = require('../config');

const STATUSES = ['open', 'overdue', 'returned'];

function register(router, { db, now }) {
  const today = () => localDay(now());

  /** Everything viewLoan needs besides the loan itself. */
  const contextFor = (loan, day, closures) => {
    const copy = repo.getCopy(db, loan.copy_id);
    return { copy, book: repo.getBook(db, copy.book_id), member: members.getMember(db, loan.member_id), today: day, closures };
  };

  router.add('POST', '/api/loans', async (req, res) => {
    const body = await readJson(req);
    const check = validate(body, {
      memberId: { type: 'integer', required: true, min: 1 },
      copyId: { type: 'integer', required: true, min: 1 },
    });
    if (!check.ok) return problem(res, 422, 'validation_failed', 'Request body is invalid', { fields: check.fields });
    const member = members.getMember(db, body.memberId);
    if (!member) return problem(res, 404, 'not_found', `Member ${body.memberId} not found`);
    const copy = repo.getCopy(db, body.copyId);
    if (!copy) return problem(res, 404, 'not_found', `Copy ${body.copyId} not found`);
    if (repo.unpaidFinesCents(db, member.id) >= cfg.unpaidFinesBlockCents) {
      return problem(res, 409, 'conflict', 'Member has unpaid fines');
    }
    if (repo.openLoanForCopy(db, copy.id)) return problem(res, 409, 'conflict', 'Copy is already on loan');
    if (repo.openLoansForMember(db, member.id).length >= cfg.maxOpenLoans) {
      return problem(res, 409, 'conflict', 'Member has reached the open loan limit');
    }
    const day = today();
    const loan = repo.insertLoan(db, {
      copy_id: copy.id,
      member_id: member.id,
      checked_out_on: day,
      due_on: dueDateFor(member, day),
      returned_on: null,
      renewals: 0,
      fine_amount: null,
      fine_paid: false,
    });
    record(db, req, now, 'create', 'loans', loan.id);
    json(res, 201, viewLoan(loan, contextFor(loan, day, repo.closureDays(db))));
  });

  router.add('POST', '/api/loans/:id/renew', async (req, res, { params }) => {
    const loan = repo.getLoan(db, params.id);
    if (!loan) return problem(res, 404, 'not_found', `Loan ${params.id} not found`);
    const day = today();
    if (loan.returned_on) return problem(res, 409, 'conflict', 'Loan has already been returned');
    if (loan.renewals >= cfg.maxRenewals) return problem(res, 409, 'conflict', 'Loan has reached the renewal limit');
    if (day > loan.due_on) return problem(res, 409, 'conflict', 'Loan is overdue');
    const ctx = contextFor(loan, day, repo.closureDays(db));
    if (repo.waitingHolds(db, ctx.book.id).some((h) => h.member_id !== loan.member_id)) {
      return problem(res, 409, 'conflict', 'Another member is waiting for this title');
    }
    const updated = repo.updateLoan(db, loan.id, { due_on: dueDateFor(ctx.member, loan.due_on), renewals: loan.renewals + 1 });
    record(db, req, now, 'update', 'loans', loan.id);
    json(res, 200, viewLoan(updated, ctx));
  });

  router.add('POST', '/api/loans/:id/return', async (req, res, { params }) => {
    const loan = repo.getLoan(db, params.id);
    if (!loan) return problem(res, 404, 'not_found', `Loan ${params.id} not found`);
    if (loan.returned_on) return problem(res, 409, 'conflict', 'Loan has already been returned');
    const day = today();
    const closures = repo.closureDays(db);
    const ctx = contextFor(loan, day, closures);
    const late = lateness(loan, { book: ctx.book, member: ctx.member, day, closures });
    const updated = repo.updateLoan(db, loan.id, { returned_on: day, fine_amount: money.toDecimal(late.fineCents) });
    record(db, req, now, 'update', 'loans', loan.id);
    json(res, 200, viewLoan(updated, ctx));
  });

  router.add('GET', '/api/members/:id/loans', async (req, res, { params, query }) => {
    const member = members.getMember(db, params.id);
    if (!member) return problem(res, 404, 'not_found', `Member ${params.id} not found`);
    const page = parsePage(query);
    const status = query.get('status');
    const fields = [...page.fields];
    if (status !== null && !STATUSES.includes(status)) fields.push('status');
    if (fields.length) return problem(res, 422, 'validation_failed', 'Query is invalid', { fields });
    const day = today();
    const closures = repo.closureDays(db);
    const all = repo
      .loansForMember(db, member.id)
      .map((l) => viewLoan(l, contextFor(l, day, closures)))
      .sort((a, b) => b.checkedOutOn.localeCompare(a.checkedOutOn) || b.id - a.id);
    const matching = status === null ? all : all.filter((l) => (status === 'open' ? l.status !== 'returned' : l.status === status));
    json(res, 200, { items: matching.slice(page.offset, page.offset + page.limit), total: matching.length });
  });
}

module.exports = { register };
