// VoIP call-intelligence module — bounded entry point.
// The ONLY integration with the host app is server.js calling start(app).
// Everything else (schema, jobs, clients) lives inside voip/.

const { ingestAllLocations } = require("./jobs/ingest");
const { processMissedCalls } = require("./jobs/missed");
const { registerSmsCallback } = require("./jobs/smsCallback");

const CYCLE_MINUTES = Number(process.env.VOIP_CRON_MINUTES || 15);

let running = false;

async function cycle() {
  if (running) { console.log("[voip] previous cycle still running, skipping"); return; }
  running = true;
  const t0 = Date.now();
  try {
    const ingested = await ingestAllLocations();
    const processed = await processMissedCalls();
    console.log(`[voip] cycle done in ${Date.now() - t0}ms — ` +
      `${ingested} CDRs upserted, ${processed} missed calls processed`);
  } catch (err) {
    console.error("[voip] cycle failed:", err.message);
  } finally {
    running = false;
  }
}

// app: the host Express app (for the inbound-SMS callback route). Optional.
function start(app) {
  if (app) registerSmsCallback(app);
  // Run shortly after boot (give Railway networking a beat), then on interval.
  setTimeout(cycle, 10_000);
  setInterval(cycle, CYCLE_MINUTES * 60_000);
  console.log(`[voip] module started — polling every ${CYCLE_MINUTES} min`);
}

module.exports = { start, cycle };
