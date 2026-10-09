// Read-only preview of the verified lessons that `eccode gate submit plan` would retrieve for a plan.
// Usage: node plan-lesson-preview.cjs <project root> <plan.json>
const path = require('node:path');
const { Store } = require('/home/user/ECCode/lib/store.js');
const { loadConfig } = require('/home/user/ECCode/lib/config.js');
const { retrieveForPlan } = require('/home/user/ECCode/lib/lessons.js');

const [root, planPath] = process.argv.slice(2);
const store = new Store(path.resolve(root));
const config = loadConfig(path.resolve(root));
const plan = require(path.resolve(planPath));
const hits = retrieveForPlan(store, config, plan, store.state().project);
console.log(JSON.stringify(hits, null, 2));
