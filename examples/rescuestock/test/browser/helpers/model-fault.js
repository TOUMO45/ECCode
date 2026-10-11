// Forces the fake extraction provider to fail in a browser journey. The server runs as a separate process, so the switch
// is the one the spec gives an operator: POST /api/admin/faults {kind: 'fake_model', fault, count} as the admin
// (RS_ADMIN_PASSWORD must be set in the harness environment). The fault applies to the next `count` extract calls.
import { createClient } from '../../helpers/fixtures.js';

export const ADMIN_PASSWORD = 'browser-admin-password-0123';

// armModelFault(server, 'timeout', 1) -> the applied fault. `server` is harness.server (startServer's result).
export async function armModelFault(server, fault, count = 1, { adminPassword = ADMIN_PASSWORD } = {}) {
  const admin = createClient(server.request);
  await admin.signIn('admin', adminPassword);
  const res = await admin.post('/api/admin/faults', { kind: 'fake_model', fault, count });
  if (res.status !== 200) throw new Error(`arming fake_model:${fault} failed with ${res.status}: ${res.text.slice(0, 200)}`);
  return res.json.applied;
}

// Clears every armed fault (so a later journey is not degraded by a fault that was not used).
export async function clearModelFaults(server, { adminPassword = ADMIN_PASSWORD } = {}) {
  const admin = createClient(server.request);
  await admin.signIn('admin', adminPassword);
  const res = await admin.post('/api/admin/faults', { kind: 'clear' });
  if (res.status !== 200) throw new Error(`clearing faults failed with ${res.status}: ${res.text.slice(0, 200)}`);
}
