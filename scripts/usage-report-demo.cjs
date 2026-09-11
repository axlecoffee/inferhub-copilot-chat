const { fetchUsageLogPage, formatUsageReport } = require("../out/inferhubUsage");

// smoke test: render a real usage report from the live API
const apiKey = process.env.INFERHUB_KEY;
if (!apiKey) {
  console.error("INFERHUB_KEY not set");
  process.exit(1);
}

(async () => {
  const page = await fetchUsageLogPage(apiKey, "24h");
  console.log(`rows=${page.rows.length} total=${page.total} rangeTotal=${page.rangeTotal}`);
  console.log(formatUsageReport(page));
})().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
