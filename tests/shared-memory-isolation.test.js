'use strict';
// TK-2: the suite must never read the shared memory of the machine it runs on. The engine's default shared
// store is ~/.eccode/memory; a lesson promoted there on a developer's machine was retrieved by fixture claims,
// whose handoffs answer no lesson, and eight unrelated tests failed. tests/helpers.js points
// ECCODE_SHARED_MEMORY at a fresh directory for every test process, before the engine is loaded.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tasks = require('../lib/tasks');
const H = require('./helpers');
const { setup } = require('./lesson-fixture');

test('a lesson promoted to this machine\'s ~/.eccode/memory is not retrieved by a fixture claim', () => {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, ECCODE_SHARED_MEMORY: process.env.ECCODE_SHARED_MEMORY };
  try {
    // A verified lesson, promoted to a shared store that is then installed as the fake home's ~/.eccode/memory.
    const seed = setup();
    const shared = seed.mem.promote(seed.lesson.id, 'technical-reviewer'); // the shared copy carries its own id
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-home-'));
    fs.cpSync(process.env.ECCODE_SHARED_MEMORY, path.join(home, '.eccode', 'memory'), { recursive: true });
    process.env.HOME = home;
    process.env.USERPROFILE = home;

    // Control: without the variable the engine reads ~/.eccode/memory and the matching task retrieves the lesson.
    const leaky = setup({ withLesson: false });
    delete process.env.ECCODE_SHARED_MEMORY;
    const seen = tasks.claim(leaky.store, leaky.config, 'credits', 'backend-engineer').event.data.lessons || [];
    assert.deepStrictEqual(seen.map((l) => l.id), [shared.id], 'the fake home\'s shared store is reachable without isolation');

    // The suite's default (what every test process starts with): the same claim retrieves nothing.
    const isolated = setup({ withLesson: false });
    process.env.ECCODE_SHARED_MEMORY = H.SHARED_MEMORY;
    const none = tasks.claim(isolated.store, isolated.config, 'credits', 'backend-engineer').event.data.lessons || [];
    assert.deepStrictEqual(none, [], 'helpers.js isolates the shared store from the machine\'s home directory');
    assert.ok(fs.existsSync(H.SHARED_MEMORY) && !fs.existsSync(path.join(H.SHARED_MEMORY, 'records', `${shared.id}.json`)));
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
