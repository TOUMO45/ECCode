'use strict';
// Stub fallback: reads the synthetic [cat=.. urg=..] tag; never echoes ticket text.
function fallbackAnalyse(ticket) {
  const m = /\[cat=([a-z_]+) urg=([a-z]+)\]/.exec(ticket);
  return { category: m ? m[1] : 'other', urgency: m ? m[2] : 'medium',
    summary: 'Customer reports an issue.', suggestedReply: 'Thank you for contacting us. Could you share more details?' };
}
module.exports = { fallbackAnalyse };
