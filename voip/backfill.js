#!/usr/bin/env node
// Historical CDR import. Usage:
//   node voip/backfill.js --from 2026-06-01 --to 2026-07-19
//
// Backfilled rows are inserted already-alerted (suppressAlerts) so a
// historical import can never flood Slack, text stale callers, or race the
// live 15-minute cycle — suppression is atomic per row, not a cleanup pass.
const { ingestAllLocations } = require("./jobs/ingest");

function arg(name) {
  const i = process.argv.indexOf("--" + name);
  return i > -1 ? process.argv[i + 1] : null;
}

async function main() {
  const from = arg("from");
  const to = arg("to") || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || "")) {
    console.error("usage: node voip/backfill.js --from YYYY-MM-DD [--to YYYY-MM-DD]");
    process.exit(1);
  }

  const n = await ingestAllLocations({ dateFrom: from, dateTo: to, suppressAlerts: true });
  console.log(`[voip] backfill ${from}..${to}: ${n} calls imported (alerts suppressed)`);
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => { console.error(err.message); process.exit(1); });
}
