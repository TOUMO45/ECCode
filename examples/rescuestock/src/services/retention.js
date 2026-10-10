// Retention sweep (spec: Retention and deletion, Background Processing > Retention sweep; RS-39, T23, FU-20).
//
//   runRetentionSweep({ db, clock, config, log, gate? })   one pass; every step is independent and a failure in one is logged
//   startRetention({ ..., intervalMs })                    one pass now, then every RS_RETENTION_INTERVAL_MS (default 1 h)
//
// A pass
//   1. deletes images whose created_at <= now - RS_IMAGE_RETENTION_DAYS (default 7 days): row and file, and writes one
//      `image.retention_delete` audit event per image (7 d + 1 min is deleted, 6 d 23 h is kept);
//   2. removes orphan files (a file in data/uploads or data/uploads/.tmp with no images row, older than 1 day), one
//      `image.orphan_delete` audit event each; only names this service generates (32 hex + png|jpg|webp) are ever touched;
//   3. purges rate_events older than 24 h, except `request_create`, which are kept 48 h so the daily count holds (FU-20: the
//      `u:<id>` rows that every signed-in call writes are removed here and not only on the user's next call);
//   4. settles model_spend rows still `reserved` after 2 x RS_MODEL_TIMEOUT_MS at their cap (a crashed call must not block
//      its customer for ever), when the gate is given.
// The clock is injected, so the thresholds are tested with a pinned clock. Audit details hold ids and counts only.
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isoFromMs } from '../clock.js';
import { IMAGE_FILE_PATTERN, TMP_DIR_NAME, imageFilePath, unlinkQuiet, uploadRoot } from './extraction.js';
import { recordAudit } from './audit.js';

export const DAY_MS = 24 * 3600 * 1000;
export const ORPHAN_AGE_MS = DAY_MS;
export const RATE_EVENT_KEEP_MS = DAY_MS;
export const REQUEST_CREATE_KEEP_MS = 2 * DAY_MS;

// ------------------------------------------------------------------ images past their retention

async function sweepExpiredImages({ db, clock, config }) {
  const cutoff = isoFromMs(clock.now() - config.imageRetentionDays * DAY_MS);
  const expired = db.prepare('SELECT id, request_id, file_name, mime_detected FROM images WHERE created_at <= ? ORDER BY id').all(cutoff);
  let deleted = 0;
  let leftForOrphanSweep = 0;
  for (const image of expired) {
    // Row and audit event first: if the file cannot be unlinked it is an orphan, and the orphan sweep removes it later.
    const removed = db.tx(() => {
      const changes = Number(db.prepare('DELETE FROM images WHERE id = ?').run(image.id).changes);
      if (changes !== 1) return false; // another process swept it first
      recordAudit(db, clock, {
        actorUserId: null, actorRole: 'system', action: 'image.retention_delete', entityType: 'image', entityId: image.id, outcome: 'ok',
        detail: { requestId: image.request_id, days: config.imageRetentionDays },
      });
      return true;
    });
    if (!removed) continue;
    deleted += 1;
    if (!(await unlinkQuiet(imageFilePath(config, image.file_name, image.mime_detected)))) leftForOrphanSweep += 1;
  }
  return { deleted, leftForOrphanSweep };
}

// ------------------------------------------------------------------ orphan files

async function listFiles(dir) {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name);
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
}

async function sweepOrphanFiles({ db, clock, config }) {
  const root = uploadRoot(config);
  const known = new Set(db.prepare('SELECT file_name, mime_detected FROM images').all().map((r) => imageFilePath(config, r.file_name, r.mime_detected)));
  let deleted = 0;
  for (const dir of [root, join(root, TMP_DIR_NAME)]) {
    for (const name of await listFiles(dir)) {
      const inTmp = dir !== root;
      if (inTmp ? !/^[0-9a-f]{32}$/.test(name) : !IMAGE_FILE_PATTERN.test(name)) continue; // never touch a file this service did not name
      const path = join(dir, name);
      if (!inTmp && known.has(path)) continue;
      let info;
      try {
        info = await stat(path);
      } catch {
        continue; // gone meanwhile
      }
      if (clock.now() - info.mtimeMs < ORPHAN_AGE_MS) continue;
      if (!(await unlinkQuiet(path))) continue;
      deleted += 1;
      recordAudit(db, clock, {
        actorUserId: null, actorRole: 'system', action: 'image.orphan_delete', entityType: 'image', entityId: null, outcome: 'ok',
        detail: { where: inTmp ? 'tmp' : 'uploads' },
      });
    }
  }
  return { deleted };
}

// ------------------------------------------------------------------ rate events (FU-20)

function purgeRateEvents({ db, clock }) {
  const now = clock.now();
  const result = db
    .prepare("DELETE FROM rate_events WHERE (kind <> 'request_create' AND at < ?) OR (kind = 'request_create' AND at < ?)")
    .run(isoFromMs(now - RATE_EVENT_KEEP_MS), isoFromMs(now - REQUEST_CREATE_KEEP_MS));
  return { deleted: Number(result.changes) };
}

// ------------------------------------------------------------------ one pass

export async function runRetentionSweep({ db, clock, config, log = null, gate = null }) {
  const summary = { images: 0, imageFilesLeft: 0, orphans: 0, rateEvents: 0, staleSpend: 0, failed: [] };
  const step = async (name, fn) => {
    try {
      await fn();
    } catch (err) {
      summary.failed.push(name);
      log?.error?.('retention.step_failed', { code: err && err.code ? String(err.code) : 'RETENTION_STEP_FAILED', kind: name });
    }
  };
  await step('images', async () => {
    const r = await sweepExpiredImages({ db, clock, config });
    summary.images = r.deleted;
    summary.imageFilesLeft = r.leftForOrphanSweep;
  });
  await step('orphans', async () => {
    summary.orphans = (await sweepOrphanFiles({ db, clock, config })).deleted;
  });
  await step('rate_events', async () => {
    summary.rateEvents = purgeRateEvents({ db, clock }).deleted;
  });
  if (gate) {
    await step('model_spend', async () => {
      summary.staleSpend = gate.settleStale({ olderThanMs: 2 * config.modelTimeoutMs });
    });
  }
  log?.info?.('retention.sweep', {
    counts: { images: summary.images, orphans: summary.orphans, rateEvents: summary.rateEvents, staleSpend: summary.staleSpend, failed: summary.failed.length },
  });
  return summary;
}

/**
 * startRetention({ db, clock, config, log, gate?, intervalMs? }) -> { stop(), runNow(), lastRun }
 * The first pass starts at once (startup); later passes every `intervalMs` (default config.retentionIntervalMs). A pass that
 * is still running is not started again. The timer is unref'd so it never keeps the process alive.
 */
export function startRetention({ db, clock, config, log = null, gate = null, intervalMs = config.retentionIntervalMs, setIntervalFn = setInterval, clearIntervalFn = clearInterval }) {
  let running = null;
  let stopped = false;
  const handle = { lastRun: null };
  const pass = () => {
    if (stopped || running) return running;
    running = runRetentionSweep({ db, clock, config, log, gate })
      .then((summary) => {
        handle.lastRun = summary;
        return summary;
      })
      .catch((err) => {
        log?.error?.('retention.failed', { code: err && err.code ? String(err.code) : 'RETENTION_FAILED' });
        return null;
      })
      .finally(() => {
        running = null;
      });
    return running;
  };
  const first = pass();
  const timer = setIntervalFn(() => {
    pass();
  }, intervalMs);
  timer.unref?.();
  handle.started = first;
  handle.runNow = () => pass();
  handle.stop = async () => {
    stopped = true;
    clearIntervalFn(timer);
    if (running) await running;
  };
  return handle;
}
