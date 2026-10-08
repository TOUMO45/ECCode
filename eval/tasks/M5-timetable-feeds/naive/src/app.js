'use strict';
const { createRouter, createServer } = require('../vendor/acme-kit/http');
const { loadDb } = require('./db');
const classes = require('./classes/routes');
const teachers = require('./teachers/routes');
const rooms = require('./rooms/routes');
const timetable = require('./timetable/routes');

function createApp({ db = loadDb(), now = () => new Date() } = {}) {
  const router = createRouter();
  const ctx = { db, now };
  classes.register(router, ctx);
  teachers.register(router, ctx);
  rooms.register(router, ctx);
  timetable.register(router, ctx);
  return createServer(router);
}

module.exports = { createApp };
