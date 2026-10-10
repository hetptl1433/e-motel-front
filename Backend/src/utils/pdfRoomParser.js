const { invalid, parseReportDate } = require('./roomData');
const { MAX_ROOMS } = require('./reportImport');

const COLUMN_LABELS = [
  ['room', /^ROOM$/i], ['type', /^(?:TYPE|ROOM TYPE)$/i],
  ['housekeepingStatus', /^HOUSEKEEPING(?: STATUS)?$/i],
  ['occupancyStatus', /^OCCUPANCY(?: STATUS)?$/i],
  ['guestStatus', /^GUEST(?: STATUS)?$/i], ['checkIn', /^CHECK[ -]?IN$/i],
  ['checkOut', /^CHECK[ -]?OUT$/i], ['orderStatus', /^ORDER(?: STATUS.*)?$/i],
  ['description', /^(?:DESCRIPTION|REASON DESCRIPTION)$/i],
  ['assignedAttendant', /^(?:ASSIGNED|ASSIGNED ATTENDANT)$/i], ['notes', /^NOTES$/i]
];

function parseTablePage(textItems) {
  const items = textItems.filter(item => typeof item.str === 'string' && item.str.trim())
    .map(item => ({ text: item.str.trim(), x: item.transform[4], y: item.transform[5] }));
  const pageText = items.map(item => item.text).join(' ');
  if (!/\bSuper\s+8\b/i.test(pageText) || !/\bRoom Status\b/i.test(pageText)) {
    throw invalid('Unsupported PDF. Upload the Super 8 Room Status report, or a CSV/JSON export');
  }
  const roomHeaders = items.filter(item => /^ROOM$/i.test(item.text)).sort((a, b) => b.y - a.y || a.x - b.x);
  const firstHeader = roomHeaders[0];
  if (!firstHeader) throw invalid('Unsupported PDF layout. Upload the Super 8 Room Status report with selectable text, or a CSV/JSON export');
  const headerItems = items.filter(item => Math.abs(item.y - firstHeader.y) < 35);
  const columns = COLUMN_LABELS.map(([field, label]) => {
    let item = headerItems.find(candidate => label.test(candidate.text));
    if (field === 'room') item = firstHeader;
    // Common source sheets split REASON / DESCRIPTION over two header lines.
    return item ? { field, x: item.x } : null;
  }).filter(Boolean).sort((a, b) => a.x - b.x);
  for (const [field] of COLUMN_LABELS) {
    if (!columns.some(column => column.field === field)) throw invalid(`PDF table is missing the ${field} column`);
  }
  if (new Set(columns.map(column => column.x)).size !== columns.length) throw invalid('PDF columns overlap');
  const roomColumn = columns.find(column => column.field === 'room');
  const body = items.filter(item => item.y < firstHeader.y - 35);
  const footer = pageText.match(/\b(\d{2})\/(\d{2})\/(\d{4})\s+\d{1,2}:\d{2}:\d{2}\s+(?:AM|PM)\s+Page\s+(\d+)\s+of\s+(\d+)\b/i);
  if (!footer) throw invalid('Super 8 report page is missing its report date and page count');
  const sourceReportDate = `${footer[3]}-${footer[1]}-${footer[2]}`;
  parseReportDate(sourceReportDate);
  const roomMarkers = body.filter(item => Math.abs(item.x - roomColumn.x) <= 5 && /^[a-z\d][a-z\d._-]{0,29}$/i.test(item.text))
    .filter(item => !/^(?:PATHS|PAGE)/i.test(item.text)).sort((a, b) => b.y - a.y);
  if (!roomMarkers.length) throw invalid('No room rows were found in this PDF page');
  if (roomMarkers.some(marker => !/^[1-9]\d{2}$/.test(marker.text))) throw invalid('Super 8 room numbers must contain exactly three digits');
  const footerY = Math.max(20, ...body.filter(item => /\bPage\s+\d+\s+of\s+\d+\b|^Room Status/i.test(item.text)).map(item => item.y + 4));
  const rows = roomMarkers.map((marker, index) => {
    const bottom = roomMarkers[index + 1]?.y ?? footerY;
    const row = { room: marker.text, ...(sourceReportDate ? { sourceReportDate } : {}) };
    const cells = {};
    for (const item of body) {
      if (item.y > marker.y + 2 || item.y <= bottom + 2 || item.x < roomColumn.x - 5) continue;
      // Each source cell begins at its header's x coordinate. Continuation lines
      // stay in the same column, so dates/notes cannot drift to neighboring rooms.
      let column = columns[0];
      for (const candidate of columns) if (item.x >= candidate.x - 5) column = candidate;
      if (column.field === 'room') continue;
      (cells[column.field] ||= []).push(item);
    }
    for (const [field, cell] of Object.entries(cells)) {
      row[field] = cell.sort((a, b) => b.y - a.y || a.x - b.x).map(item => item.text).join(' ');
    }
    row.pet = Object.values(row).some(value => typeof value === 'string' && /\bpet in room\b/i.test(value));
    if (row.pet) {
      // Some PMS sheets put this marker beneath the occupancy cell.
      row.occupancyStatus = row.occupancyStatus?.replace(/\bpet in room\b/ig, '').trim();
      if (!/\bpet in room\b/i.test(row.notes || '')) row.notes = [row.notes, 'Pet In Room'].filter(Boolean).join(' ');
    }
    if (!row.type || !row.housekeepingStatus || !row.occupancyStatus) {
      throw invalid(`PDF room ${row.room} is missing required table data`);
    }
    return row;
  });
  rows.metadata = { sourceReportDate, pageNumber: Number(footer[4]), pageCount: Number(footer[5]) };
  return rows;
}

async function parseRoomPDF(buffer) {
  if (!buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw invalid('The uploaded file is not a valid PDF');
  const parse = require('pdf-parse');
  const rooms = [];
  const errors = [];
  const pageMetadata = [];
  let renderedPages = 0;
  let parsed;
  try {
    parsed = await parse(buffer, {
      max: 100,
      pagerender: async page => {
        renderedPages += 1;
        try {
          const content = await page.getTextContent({ normalizeWhitespace: true, disableCombineTextItems: false });
          const rows = parseTablePage(content.items);
          pageMetadata.push(rows.metadata);
          rooms.push(...rows);
          if (rooms.length > MAX_ROOMS) throw invalid(`A report may contain at most ${MAX_ROOMS} rooms`);
        } catch (error) { errors.push(error); }
        return '';
      }
    });
  } catch { throw invalid('Unable to read this PDF; upload a valid, unlocked room report'); }
  if (parsed.numpages > 100 || renderedPages !== parsed.numpages) throw invalid('PDF exceeds the 100-page limit or contains unreadable pages');
  // pdf-parse swallows pagerender errors. Capture them ourselves so a failed page
  // can never become a successful partial import.
  if (errors.length) throw errors[0];
  if (!rooms.length) throw invalid('The PDF contains no recognizable rooms');
  if (pageMetadata.some((page, index) => page.pageNumber !== index + 1 || page.pageCount !== parsed.numpages)) {
    throw invalid('PDF page numbers are missing or inconsistent. Upload the complete daily report in order');
  }
  const dates = new Set(rooms.map(room => room.sourceReportDate).filter(Boolean));
  if (dates.size > 1) throw invalid('PDF pages contain different report dates. Upload a single daily report');
  rooms.sourceReportDate = [...dates][0];
  rooms.pageCount = parsed.numpages;
  return rooms;
}

module.exports = { parseRoomPDF, parseTablePage };
