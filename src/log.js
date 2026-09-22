/** Minimal structured logger: one JSON line per event, easy to grep or ship to a log service. */
const write = (level, msg, fields) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields }));

export const log = {
  info: (msg, fields) => write('info', msg, fields),
  warn: (msg, fields) => write('warn', msg, fields),
  error: (msg, fields) => write('error', msg, fields),
};
