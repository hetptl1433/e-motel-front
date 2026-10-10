export const HOUSEKEEPING_STATUSES = ['Clean', 'Dirty', 'Out of Order', 'Maintenance'];

export function localDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function isReportDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const date = new Date(`${value}T12:00:00`);
  return !Number.isNaN(date.getTime()) && localDate(date) === value;
}

export function shiftDate(value, days) {
  const date = new Date(`${value}T12:00:00`);
  date.setDate(date.getDate() + days);
  return localDate(date);
}

export function extractRooms(payload) {
  const rooms = Array.isArray(payload) ? payload : payload?.data;
  if (!Array.isArray(rooms)) throw new Error('The server returned an invalid room list. Please refresh and try again.');
  return rooms;
}

export function requestError(error, fallback) {
  if (error.response) return error.response.data?.message || error.response.data?.error || fallback;
  if (error.request || error.code === 'ERR_NETWORK') return 'Cannot reach the server. Check your connection and try again.';
  return error.message || fallback;
}

export function roomNumber(room) {
  return String(room.room ?? room.roomNumber ?? room.number ?? '—');
}

export function sortRooms(rooms) {
  return [...rooms].sort((a, b) => roomNumber(a).localeCompare(roomNumber(b), undefined, { numeric: true }));
}

// Compare the raw server response before merging it with local fields. Giving
// an unversioned response the current timestamp would hide that it may be stale.
export function mergeRoomRecord(existing, incoming) {
  if (!incoming || typeof incoming !== 'object') return existing;
  if (!existing) return { ...incoming };
  const currentTime = Date.parse(existing.updatedAt);
  const incomingTime = Date.parse(incoming.updatedAt);
  if (Number.isFinite(currentTime) && (!Number.isFinite(incomingTime) || incomingTime < currentTime)) return existing;
  return { ...existing, ...incoming };
}

const unavailableOrderCodes = new Set(['ooi', 'oi', 'ooo', 'oo', 'oos']);

export function roomStatus(room) {
  if (room.housekeepingStatus === 'Maintenance') return 'Maintenance';
  const orderStatus = String(room.orderStatus || '').trim().toLowerCase().replace(/[\s_-]+/g, ' ');
  const unavailable = /\bout of (order|inventory|service)\b/.test(orderStatus) || orderStatus.split(/[/,]/).some(code => unavailableOrderCodes.has(code.trim()));
  if (room.housekeepingStatus === 'Out of Order' || unavailable) return 'Out of Order';
  return room.housekeepingStatus || 'Unavailable';
}

export function isRoomUnavailable(room) {
  return !['Clean', 'Dirty'].includes(roomStatus(room));
}

// Both boards use the same meanings. An occupied room must wait for checkout.
export function roomWorkflow(room) {
  if (isRoomUnavailable(room)) return 'unavailable';
  if (room.occupancyStatus === 'Occupied') return 'waiting';
  if (room.occupancyStatus !== 'Vacant') return 'unavailable';
  return roomStatus(room) === 'Clean' ? 'done' : 'ready';
}

// Reports may contain dates such as “May 22” or “05/22”. Use the report year
// when comparing them, while leaving unrecognized text untouched in the editor.
export function normalizedStayDate(value, reportDate) {
  if (!value) return '';
  const text = String(value).trim();
  if (isReportDate(text.slice(0, 10))) return text.slice(0, 10);
  const year = String(reportDate || localDate()).slice(0, 4);
  const numeric = text.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (numeric) {
    const numericYear = numeric[3] ? (numeric[3].length === 2 ? `20${numeric[3]}` : numeric[3]) : year;
    const candidate = `${numericYear}-${numeric[1].padStart(2, '0')}-${numeric[2].padStart(2, '0')}`;
    return isReportDate(candidate) ? candidate : '';
  }
  const named = text.match(/^([A-Za-z]+)\s+(\d{1,2})(?:,?\s+(\d{4}))?$/);
  if (!named) return '';
  const months = {
    jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
    may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
    sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12
  };
  const month = months[named[1].toLowerCase()];
  if (!month) return '';
  const candidate = `${named[3] || year}-${String(month).padStart(2, '0')}-${named[2].padStart(2, '0')}`;
  return isReportDate(candidate) ? candidate : '';
}
