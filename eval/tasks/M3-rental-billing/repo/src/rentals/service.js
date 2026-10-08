'use strict';
// Rental view.

function viewRental(rental, item) {
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
  };
}

module.exports = { viewRental };
