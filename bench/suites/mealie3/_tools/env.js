'use strict';
// The third Mealie suite builds its environments as the pilot's suite does
// (one venv per uv.lock, one node_modules per frontend lockfile, under
// $ECCODE_MEALIE_ENVS); this file is where its tasks' setup finds them.
const env = require('../../mealie/_tools/env');

module.exports = env;

if (require.main === module) env.cli(process.argv.slice(2));
