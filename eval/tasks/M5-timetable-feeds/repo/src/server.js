'use strict';
const { createApp } = require('./app');

const port = Number(process.env.PORT || 3000);
createApp().listen(port, '127.0.0.1', () => console.log(`timetable-service listening on http://127.0.0.1:${port}`));
