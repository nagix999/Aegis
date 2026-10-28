/** A request-independent runner. Durable jobs and leases remain in the API store. */
export async function startEvaluationRunner({ heartbeat, processQueue, disconnect, onError = () => {}, intervalMs = 1000, heartbeatMs = 10000 }) {
  if (![intervalMs, heartbeatMs].every(value => Number.isFinite(value) && value >= 10)) throw new Error('Worker intervals must be at least 10 ms.');
  let stopped = false;
  let processing;
  let beating;
  let stopPromise;
  const report = phase => { try { onError(phase); } catch { /* Reporting must not stop recovery. */ } };
  const beat = () => {
    if (stopped || beating) return beating;
    beating = Promise.resolve().then(heartbeat).catch(() => report('heartbeat')).finally(() => { beating = undefined; });
    return beating;
  };
  const process = () => {
    if (stopped || processing) return processing;
    processing = Promise.resolve().then(processQueue).catch(() => report('process')).finally(() => { processing = undefined; });
    return processing;
  };
  await beat();
  const heartbeatTimer = setInterval(beat, heartbeatMs);
  const processTimer = setInterval(process, intervalMs);
  void process();
  return {
    stop() {
      if (stopPromise) return stopPromise;
      stopped = true;
      clearInterval(heartbeatTimer);
      clearInterval(processTimer);
      stopPromise = (async () => {
        // Do not close SQLite while a leased batch is still committing.
        await Promise.allSettled([processing, beating].filter(Boolean));
        try { await disconnect(); } catch { report('disconnect'); }
      })();
      return stopPromise;
    },
  };
}
