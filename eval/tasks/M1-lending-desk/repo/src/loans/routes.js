'use strict';
const { json, problem, readJson, validate } = require('../../vendor/acme-kit/http');
const repo = require('./repository');
const members = require('../members/repository');
const { dueDateFor, viewLoan } = require('./service');
const { localDay } = require('../lib/dates');
const { maxOpenLoans } = require('../config');

function register(router, { db, now }) {
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
    if (repo.openLoanForCopy(db, copy.id)) return problem(res, 409, 'conflict', 'Copy is already on loan');
    if (repo.openLoansForMember(db, member.id).length >= maxOpenLoans) {
      return problem(res, 409, 'conflict', 'Member has reached the open loan limit');
    }
    const today = localDay(now());
    const loan = repo.insertLoan(db, {
      copy_id: copy.id,
      member_id: member.id,
      checked_out_on: today,
      due_on: dueDateFor(today),
      returned_on: null,
      renewals: 0,
      fine_amount: null,
      fine_paid: false,
    });
    json(res, 201, viewLoan(loan, copy));
  });
}

module.exports = { register };
