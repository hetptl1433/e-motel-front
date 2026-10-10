const {
  parseReportDate, normalizeRoomNumber, normalizeHousekeepingStatus,
  normalizeOccupancyStatus, invalid
} = require('./roomData');

const MAX_ROOMS = 1000;
const TEXT_FIELDS = ['type', 'guestStatus', 'orderStatus', 'reason', 'description', 'assignedAttendant', 'notes'];

// RFC 4180-style CSV, including quoted commas, escaped quotes and multiline notes.
function parseCSV(text) {
  const rows = [];
  let row = [], value = '', quoted = false, closedQuote = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { value += '"'; i += 1; }
      else if (ch === '"') { quoted = false; closedQuote = true; }
      else value += ch;
    } else if (ch === '"') {
      if (value.trim() || closedQuote) throw invalid('Invalid CSV quotation');
      value = ''; quoted = true;
    } else if (ch === ',' || ch === '\n' || ch === '\r') {
      row.push(value.trim()); value = ''; closedQuote = false;
      if (ch !== ',') {
        if (row.some(cell => cell !== '')) rows.push(row);
        row = [];
        if (ch === '\r' && text[i + 1] === '\n') i += 1;
      }
    } else {
      if (closedQuote && !/\s/.test(ch)) throw invalid('Unexpected text after a quoted CSV field');
      if (!closedQuote) value += ch;
    }
  }
  if (quoted) throw invalid('CSV contains an unterminated quoted field');
  row.push(value.trim());
  if (row.some(cell => cell !== '')) rows.push(row);
  if (rows.length < 2) throw invalid('CSV must include headers and at least one room');
  const headers = rows.shift().map(header => header.trim());
  if (headers.some(header => !header) || new Set(headers).size !== headers.length) {
    throw invalid('CSV headers must be present and unique');
  }
  return rows.map((cells, index) => {
    if (cells.length !== headers.length) throw invalid(`CSV row ${index + 2} has the wrong number of columns`);
    return Object.fromEntries(headers.map((header, column) => [header, cells[column]]));
  });
}

function parseJSON(text) {
  let value;
  try { value = JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch { throw invalid('The uploaded file does not contain valid JSON'); }
  const rooms = Array.isArray(value) ? value : value?.rooms;
  if (!Array.isArray(rooms)) throw invalid('JSON must contain a room array or an object with a rooms array');
  return rooms;
}

function optionalText(value, field) {
  if (value === null || value === undefined || value === '') return null;
  if (!['string', 'number'].includes(typeof value)) throw invalid(`${field} must be text`);
  const text = String(value).trim();
  if (text.length > 4000) throw invalid(`${field} must be at most 4000 characters`);
  return text || null;
}

function dateText(value, reportDate, { strict = false } = {}) {
  const text = optionalText(value, 'Check-in/check-out date');
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(text)) {
    const day = text.slice(0, 10);
    parseReportDate(day);
    return day;
  }
  const usDate = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (usDate) {
    const day = `${usDate[3]}-${usDate[1].padStart(2, '0')}-${usDate[2].padStart(2, '0')}`;
    parseReportDate(day);
    return day;
  }
  const monthDate = text.match(/^([a-z]+)\s+(\d{1,2})(?:,?\s+(\d{4}))?$/i);
  if (monthDate) {
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const month = months.indexOf(monthDate[1].slice(0, 3).toLowerCase()) + 1;
    if (month) {
      const base = parseReportDate(reportDate);
      const years = monthDate[3] ? [Number(monthDate[3])] : [base.getUTCFullYear() - 1, base.getUTCFullYear(), base.getUTCFullYear() + 1];
      const candidates = years.map(year => `${year}-${String(month).padStart(2, '0')}-${monthDate[2].padStart(2, '0')}`)
        .filter(day => { try { parseReportDate(day); return true; } catch { return false; } });
      if (!candidates.length) throw invalid('Check-in/check-out date is invalid');
      return candidates.sort((a, b) => Math.abs(Date.parse(a) - base.getTime()) - Math.abs(Date.parse(b) - base.getTime()))[0];
    }
  }
  if (strict) throw invalid(`Unsupported check-in/check-out date: ${text}`);
  return text;
}

function normalizePet(value) {
  if ([null, undefined, '', false, 0].includes(value)) return false;
  if (value === true || value === 1) return true;
  if (typeof value === 'string') {
    if (['true', 'yes', '1'].includes(value.trim().toLowerCase())) return true;
    if (['false', 'no', '0'].includes(value.trim().toLowerCase())) return false;
  }
  throw invalid('pet must be true or false');
}

function prepareRooms(input, reportDate, { requireType = false, strictDates = false } = {}) {
  const day = parseReportDate(reportDate);
  if (!Array.isArray(input) || !input.length) throw invalid('The report contains no rooms');
  if (input.length > MAX_ROOMS) throw invalid(`A report may contain at most ${MAX_ROOMS} rooms`);
  const seen = new Set();
  return input.map((source, index) => {
    try {
      if (!source || typeof source !== 'object' || Array.isArray(source)) throw invalid('Room must be an object');
      const room = normalizeRoomNumber(source.room ?? source.roomNumber ?? source.number);
      if (seen.has(room)) throw invalid(`Duplicate room ${room} in this report`);
      seen.add(room);
      const result = {
        room,
        housekeepingStatus: normalizeHousekeepingStatus(source.housekeepingStatus ?? source.status),
        occupancyStatus: normalizeOccupancyStatus(source.occupancyStatus ?? source.occupancy),
        reportDate: day,
        checkIn: dateText(source.checkIn, source.sourceReportDate || reportDate, { strict: strictDates }),
        checkOut: dateText(source.checkOut, source.sourceReportDate || reportDate, { strict: strictDates }),
        pet: normalizePet(source.pet)
      };
      for (const field of TEXT_FIELDS) result[field] = optionalText(source[field], field);
      if (requireType && !result.type) throw invalid(`Room ${room} is missing its type`);
      return result;
    } catch (error) {
      error.message = `Room row ${index + 1}: ${error.message}`;
      throw error;
    }
  }).sort((a, b) => a.room.localeCompare(b.room, undefined, { numeric: true }));
}

module.exports = { MAX_ROOMS, parseCSV, parseJSON, prepareRooms, dateText };
