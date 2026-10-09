// Authorization (spec 3.9). Default deny: unknown actions and roles get false.
const ALL = ['viewer', 'responder', 'lead'];
const WORK = ['responder', 'lead'];
const LEAD = ['lead'];

export const POLICY = Object.freeze({
  'me': ALL,
  'logout': ALL,
  'postmortem.read': ALL,
  'provider.list': WORK,
  'incident.list': WORK,
  'incident.get': WORK,
  'incident.create': WORK,
  'notes.read': WORK,
  'notes.replace': WORK,
  'draft.read': WORK,
  'draft.generate': WORK,
  'statement.edit': WORK,
  'statement.delete': WORK,
  'draft.publish': LEAD,
  'user.list': LEAD,
  'user.create': LEAD,
  'audit.read': LEAD,
});

export function authorize(user, action) {
  if (!user || typeof user.role !== 'string' || !Object.hasOwn(POLICY, action)) return false;
  return POLICY[action].includes(user.role);
}

/** Actions whose denial is itself written to the audit log. */
export const AUDIT_ON_DENY = new Set(['draft.publish', 'user.list', 'user.create', 'audit.read']);
