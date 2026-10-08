'use strict';
// Rental view with its charge.
const money = require('../../vendor/acme-kit/money');
const items = require('../items/repository');
const customers = require('../customers/repository');
const { chargeFor } = require('./pricing');

/** Charge in cents for a rental, looking up its item, tax rate and customer. */
function chargeOf(db, rental) {
  const item = items.getItem(db, rental.item_id);
  const customer = customers.getCustomer(db, rental.customer_id);
  return { item, charge: chargeFor(rental, { item, taxBp: items.taxBpFor(db, item.category), taxExempt: Boolean(customer.tax_exempt) }) };
}

function viewRental(db, rental) {
  const { item, charge } = chargeOf(db, rental);
  return {
    id: rental.id,
    customerId: rental.customer_id,
    itemId: rental.item_id,
    sku: item.sku,
    item: item.name,
    startDate: rental.start_date,
    dueDate: rental.due_date,
    returnedOn: rental.returned_on,
    status: rental.status,
    days: charge.days,
    lateDays: charge.lateDays,
    rental: money.toDecimal(charge.rental),
    lateFee: money.toDecimal(charge.lateFee),
    subtotal: money.toDecimal(charge.subtotal),
    tax: money.toDecimal(charge.tax),
    total: money.toDecimal(charge.total),
    deposit: money.toDecimal(charge.deposit),
  };
}

module.exports = { chargeOf, viewRental };
