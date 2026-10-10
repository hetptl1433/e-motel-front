const path = require('path');
const { parseReportDate, isRoomUnavailable } = require('./roomData');

const reportsDirectory = path.join(__dirname, '../../reports');
function sourceReportPath(date, directory = reportsDirectory) {
  parseReportDate(date);
  return path.join(directory, `room_sheet_${date}.pdf`);
}

function printable(value) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2010-\u2015]/g, '-').replace(/[^\x20-\x7e\xa0-\xff]/g, '?');
}
function pdfString(value) { return printable(value).replace(/([\\()])/g, '\\$1'); }
function wrapText(value, limit) {
  const text = printable(value).trim();
  if (!text) return ['-'];
  const lines = [];
  let line = '';
  for (let word of text.split(/\s+/)) {
    if (line && line.length + word.length + 1 > limit) { lines.push(line); line = ''; }
    while (word.length > limit) {
      if (line) { lines.push(line); line = ''; }
      lines.push(word.slice(0, limit)); word = word.slice(limit);
    }
    if (word) line += `${line ? ' ' : ''}${word}`;
  }
  if (line) lines.push(line);
  return lines;
}

// A small local PDF writer: standard PDF fonts, no SDK, shell command, cloud
// storage, or internet access is needed to download a current room sheet.
function buildRoomSheetPDF(rooms, date) {
  parseReportDate(date);
  const sorted = [...rooms].sort((a, b) => String(a.room).localeCompare(String(b.room), undefined, { numeric: true }));
  const columns = [
    ['Room', 'room', 40], ['Type', 'type', 48], ['Housekeeping', 'housekeepingStatus', 85],
    ['Occupancy', 'occupancyStatus', 70], ['Guest status', 'guestStatus', 83],
    ['Check-in', 'checkIn', 75], ['Check-out', 'checkOut', 75], ['Attendant', 'assignedAttendant', 105], ['Pet', 'pet', 47]
  ];
  const pageWidth = 792, pageHeight = 612, left = 32, right = 760, bottom = 46;
  const pages = [];
  let content = [], cursor;
  const text = (x, y, value, size = 8, bold = false, color = '0.12 0.17 0.23') => {
    content.push(`${color} rg BT /${bold ? 'F2' : 'F1'} ${size} Tf 1 0 0 1 ${x} ${y} Tm (${pdfString(value)}) Tj ET`);
  };
  const rect = (x, y, width, height, color) => content.push(`${color} rg ${x} ${y} ${width} ${height} re f`);
  const line = (x1, y1, x2, y2) => content.push(`0.8 0.84 0.88 RG 0.4 w ${x1} ${y1} m ${x2} ${y2} l S`);
  const startPage = () => {
    if (content.length) pages.push(content.join('\n'));
    content = [];
    text(left, 573, 'Super 8 - Room Status', 18, true);
    text(left, 552, `Report date: ${date}`, 10);
    const occupied = sorted.filter(room => room.occupancyStatus === 'Occupied').length;
    const unavailable = sorted.filter(isRoomUnavailable).length;
    const clean = sorted.filter(room => !isRoomUnavailable(room) && room.housekeepingStatus === 'Clean').length;
    const dirty = sorted.filter(room => !isRoomUnavailable(room) && room.housekeepingStatus === 'Dirty').length;
    text(left, 534, `${sorted.length} rooms  |  ${occupied} occupied  |  ${sorted.length - occupied} vacant  |  ${clean} clean  |  ${dirty} dirty  |  ${unavailable} unavailable`, 9);
    rect(left, 499, right - left, 25, '0.12 0.19 0.27');
    let x = left;
    for (const [label, , width] of columns) { text(x + 5, 509, label, 8, true, '1 1 1'); x += width; }
    cursor = 499;
    text(left, 24, 'Generated from the saved room statuses. The original uploaded PDF is available separately.', 8, false, '0.35 0.4 0.46');
    text(710, 24, `Page ${pages.length + 1}`, 8, false, '0.35 0.4 0.46');
  };
  startPage();
  sorted.forEach((room, rowIndex) => {
    const extra = [];
    if (isRoomUnavailable(room)) extra.push('Availability: Unavailable');
    const cells = columns.map(([, field, width]) => {
      const value = field === 'pet' ? (room.pet ? 'Yes' : 'No') : room[field];
      const all = wrapText(value, Math.max(6, Math.floor((width - 10) / 4.8)));
      if (all.length > 3) extra.push(`${field}: ${value}`);
      return all.length > 3 ? [...all.slice(0, 2), `${all[2].slice(0, -3)}...`] : all;
    });
    for (const [label, field] of [['Order', 'orderStatus'], ['Reason', 'reason'], ['Description', 'description'], ['Notes', 'notes']]) {
      if (room[field]) extra.push(`${label}: ${room[field]}`);
    }
    const detailLines = extra.flatMap(value => wrapText(value, 145));
    let remaining = detailLines, continued = false;
    do {
      const cellLines = continued ? [[String(room.room)], ['(cont.)'], ...columns.slice(2).map(() => [''])] : cells;
      const mainHeight = Math.max(...cellLines.map(cell => cell.length)) * 11 + 8;
      if (cursor - mainHeight - (remaining.length ? 13 : 0) < bottom) startPage();
      const availableLines = Math.max(0, Math.floor((cursor - bottom - mainHeight - 4) / 11));
      const shown = remaining.slice(0, availableLines);
      remaining = remaining.slice(shown.length);
      const height = mainHeight + (shown.length ? shown.length * 11 + 4 : 0);
      const y = cursor - height;
      rect(left, y, right - left, height, rowIndex % 2 ? '0.96 0.97 0.98' : '1 1 1');
      let x = left;
      cellLines.forEach((cell, column) => {
        cell.forEach((value, index) => text(x + 5, cursor - 13 - index * 11, value, 8, column === 0));
        x += columns[column][2];
      });
      shown.forEach((value, index) => text(left + 5, cursor - mainHeight - 10 - index * 11, value, 8, false, '0.3 0.35 0.4'));
      line(left, y, right, y);
      cursor = y;
      continued = true;
      if (remaining.length) startPage();
    } while (remaining.length);
  });
  if (!sorted.length) text(left + 5, 476, 'No room statuses saved for this date.', 10);
  pages.push(content.join('\n'));

  const objects = [];
  const add = value => { objects.push(value); return objects.length; };
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add('');
  const normalFont = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const boldFont = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const pageIds = pages.map(stream => {
    const streamId = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    return add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 ${normalFont} 0 R /F2 ${boldFont} 0 R >> >> /Contents ${streamId} 0 R >>`);
  });
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  let pdf = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf, 'latin1')); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  // Older PDF.js readers mishandle very short files. A harmless PDF comment
  // keeps even one-room sheets compatible without changing any object offsets.
  const currentLength = Buffer.byteLength(pdf, 'latin1');
  if (currentLength < 4096) pdf += `%${' '.repeat(4096 - currentLength)}\n`;
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

module.exports = { reportsDirectory, sourceReportPath, buildRoomSheetPDF, wrapText };
