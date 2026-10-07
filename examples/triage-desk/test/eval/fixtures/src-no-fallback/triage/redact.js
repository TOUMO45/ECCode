'use strict';
function redact(text) { return { text, counts: { email: 0, card: 0, phone: 0 } }; }
module.exports = { redact };
