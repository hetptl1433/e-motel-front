const { parseReportDate, isRoomUnavailable, invalid } = require('./roomData');

function normalizedStayDate(value, reportDate) {
  if (!value) return '';
  try {
    const text = String(value).trim();
    let normalized;
    if (/^\d{4}-\d{2}-\d{2}/.test(text)) normalized = text.slice(0, 10);
    const numeric = text.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
    if (numeric) {
      const year = numeric[3] ? (numeric[3].length === 2 ? `20${numeric[3]}` : numeric[3]) : reportDate.slice(0, 4);
      normalized = `${year}-${numeric[1].padStart(2, '0')}-${numeric[2].padStart(2, '0')}`;
    }
    const named = text.match(/^([A-Za-z]+)\s+(\d{1,2})(?:,?\s+(\d{4}))?$/);
    if (named) {
      const months = {
        jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
        may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
        sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12
      };
      const month = months[named[1].toLowerCase()];
      if (!month) return '';
      normalized = `${named[3] || reportDate.slice(0, 4)}-${String(month).padStart(2, '0')}-${named[2].padStart(2, '0')}`;
    }
    parseReportDate(normalized);
    return normalized;
  } catch {
    return '';
  }
}

function isStayover(record) {
  if (!record || !record.reportDate || record.occupancyStatus !== 'Occupied' || isRoomUnavailable(record)
    || !['Clean', 'Dirty'].includes(record.housekeepingStatus)) return false;
  const guestStatus = String(record.guestStatus || '').trim().toLowerCase().replace(/[\s_-]+/g, ' ');
  if (/^(?:due\s*out|checked\s*out)\b/.test(guestStatus)) return false;
  let reportDate;
  try {
    reportDate = new Date(record.reportDate).toISOString().slice(0, 10);
    parseReportDate(reportDate);
  } catch {
    return false;
  }
  const departure = normalizedStayDate(record.checkOut, reportDate);
  if (departure) return departure > reportDate;
  return ['stay over', 'stayover'].includes(guestStatus);
}

function assertCanServiceStayover(record, updates) {
  if (!record || !Object.hasOwn(updates, 'stayoverServicedAt')) return;
  if (!isStayover(record)) {
    const error = invalid('Stayover service can only be updated for an available occupied room whose guest is continuing their stay');
    error.status = 409;
    throw error;
  }
}

module.exports = { normalizedStayDate, isStayover, assertCanServiceStayover };
