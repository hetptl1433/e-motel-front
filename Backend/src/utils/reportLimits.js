const LOCAL_REPORT_BYTES = 10 * 1024 * 1024;
const VERCEL_REPORT_BYTES = 4 * 1024 * 1024;

function reportSizeError(vercel = false) {
  const error = new Error(`Report files must be ${vercel ? 4 : 10} MB or smaller`);
  error.status = 413;
  return error;
}

module.exports = { LOCAL_REPORT_BYTES, VERCEL_REPORT_BYTES, reportSizeError };
