// Logs go to the store too so the web app can show them (spec: "logs visible in the web app").
export function createLogger(store, { quiet = false } = {}) {
  return function log(agent, level, message, data) {
    store.addLog({ agent, level, message, data });
    if (!quiet) {
      const line = `[${agent}] ${message}`;
      if (level === 'error') console.error(line, data ?? '');
      else if (level === 'warn') console.warn(line, data ?? '');
      else console.log(line);
    }
  };
}
