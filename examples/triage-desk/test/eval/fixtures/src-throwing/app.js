'use strict';
// Fixture: must never be loaded in --results mode (lazy-require check).
throw new Error('FIXTURE_LOADED_EAGERLY');
