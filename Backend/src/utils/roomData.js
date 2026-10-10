const HOUSEKEEPING_STATUSES = ['Clean', 'Dirty', 'Out of Order', 'Maintenance'];
const OCCUPANCY_STATUSES = ['Occupied', 'Vacant'];

function invalid(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function recordChanged() {
  const error = invalid('This room changed while you were updating it. Refresh and try again');
  error.status = 409;
  return error;
}

function expectedVersion(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('Record data must be an object');
  const { expectedUpdatedAt, ...data } = input;
  if (expectedUpdatedAt === undefined) return { data, expectedUpdatedAt };
  if (typeof expectedUpdatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(expectedUpdatedAt)
    || Number.isNaN(new Date(expectedUpdatedAt).getTime())) throw invalid('expectedUpdatedAt must be a valid ISO timestamp');
  parseReportDate(expectedUpdatedAt.slice(0, 10));
  return { data, expectedUpdatedAt: new Date(expectedUpdatedAt) };
}

function assertExpectedVersion(record, expectedUpdatedAt) {
  if (expectedUpdatedAt !== undefined && (!record?.updatedAt || new Date(record.updatedAt).getTime() !== expectedUpdatedAt.getTime())) throw recordChanged();
}

function parseReportDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw invalid('Date must use YYYY-MM-DD format');
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw invalid('Date must be a valid calendar date');
  }
  return date;
}

function dateRange(value) {
  const start = parseReportDate(value);
  return { $gte: start, $lt: new Date(start.getTime() + 86400000) };
}

function normalizeRoomNumber(value) {
  if (!['string', 'number'].includes(typeof value)) throw invalid('Room number is required');
  const room = String(value).trim();
  if (!room || room.length > 30 || !/^[a-z\d][a-z\d ._-]*$/i.test(room)) {
    throw invalid('Room number must contain letters or numbers and be at most 30 characters');
  }
  return room;
}

function normalizedKey(value) {
  return typeof value === 'string' ? value.trim().toLowerCase().replace(/[\s_-]+/g, ' ') : '';
}

function normalizeHousekeepingStatus(value) {
  const aliases = {
    clean: 'Clean', cleaned: 'Clean', inspected: 'Clean', ready: 'Clean',
    dirty: 'Dirty', 'needs cleaning': 'Dirty',
    'out of order': 'Out of Order', ooo: 'Out of Order',
    maintenance: 'Maintenance', 'out of service': 'Maintenance', oos: 'Maintenance'
  };
  const status = aliases[normalizedKey(value)];
  if (!status) throw invalid(`Housekeeping status must be one of: ${HOUSEKEEPING_STATUSES.join(', ')}`);
  return status;
}

function normalizeOccupancyStatus(value) {
  const aliases = { occupied: 'Occupied', occ: 'Occupied', vacant: 'Vacant', vac: 'Vacant', empty: 'Vacant' };
  const status = aliases[normalizedKey(value)];
  if (!status) throw invalid('Occupancy status must be Occupied or Vacant');
  return status;
}

function isOutOfOrder(record) {
  if (record.housekeepingStatus === 'Out of Order') return true;
  const value = normalizedKey(record.orderStatus);
  if (/\bout of (order|inventory|service)\b/.test(value)) return true;
  return value.split(/[\/,]/).some(token => ['ooo', 'ooi', 'oi', 'oo', 'oos'].includes(token.trim()));
}

function isRoomUnavailable(record) {
  return record.housekeepingStatus === 'Maintenance' || isOutOfOrder(record);
}

function assertStaffCanClean(record, updates, role) {
  if (!record || role !== 'housekeeping' || !['Clean', 'Dirty'].includes(updates.housekeepingStatus)) return;
  if (isRoomUnavailable(record)) {
    const error = invalid('Unavailable rooms must be released by the front desk or an administrator before cleaning status can change');
    error.status = 409;
    throw error;
  }
  if (record.occupancyStatus === 'Occupied') {
    const error = invalid('Wait for the front desk to mark the guest as checked out before cleaning this room');
    error.status = 409;
    throw error;
  }
}

const TEXT_FIELDS = ['type', 'guestStatus', 'checkIn', 'checkOut', 'orderStatus', 'reason', 'description', 'assignedAttendant', 'notes'];
const ROOM_FIELDS = ['room', ...TEXT_FIELDS, 'housekeepingStatus', 'occupancyStatus', 'pet', 'reportDate'];
const HOUSEKEEPING_FIELDS = ['roomNumber', ...TEXT_FIELDS, 'housekeepingStatus', 'occupancyStatus', 'pet', 'reportDate', 'cleanedAt', 'inspectedAt', 'stayoverServicedAt', 'issues', 'photos'];
const STAFF_ROOM_FIELDS = ['housekeepingStatus', 'notes'];
const STAFF_HOUSEKEEPING_FIELDS = ['housekeepingStatus', 'notes', 'cleanedAt', 'inspectedAt', 'stayoverServicedAt', 'issues', 'photos'];

function normalizeFields(input, { housekeeping = false, partial = false, role, imported = false, reportDate } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('Record data must be an object');
  const fields = housekeeping ? HOUSEKEEPING_FIELDS : ROOM_FIELDS;
  const permitted = partial && role === 'housekeeping'
    ? (housekeeping ? STAFF_HOUSEKEEPING_FIELDS : STAFF_ROOM_FIELDS)
    : (partial ? fields.filter(field => !['room', 'roomNumber', 'reportDate'].includes(field)) : fields);
  // Service completion is staff progress, written only against a checked current
  // record. A new/imported report cannot claim that service has already happened.
  const editableFields = partial ? permitted : permitted.filter(field => field !== 'stayoverServicedAt');
  if (!imported) {
    const unsupported = Object.keys(input).filter(key => !editableFields.includes(key));
    if (unsupported.length) throw invalid(`Fields cannot be changed: ${unsupported.join(', ')}`);
  }
  const record = {};
  for (const field of fields) {
    if (input[field] !== undefined && !(field === 'stayoverServicedAt' && imported)) record[field] = input[field];
  }
  if (imported && housekeeping) {
    for (const flag of ['clean', 'dirty', 'occupied', 'vacant']) {
      if (input[flag] !== undefined && typeof input[flag] !== 'boolean') throw invalid(`${flag} must be true or false`);
    }
    if (input.clean === true && input.dirty === true) throw invalid('A room cannot be both clean and dirty');
    if (input.occupied === true && input.vacant === true) throw invalid('A room cannot be both occupied and vacant');
    record.roomNumber = input.roomNumber ?? input.room;
    if (record.housekeepingStatus === undefined && (input.clean !== undefined || input.dirty !== undefined)) {
      record.housekeepingStatus = input.clean === true ? 'Clean' : 'Dirty';
    }
    if (record.occupancyStatus === undefined && (input.occupied !== undefined || input.vacant !== undefined)) {
      record.occupancyStatus = input.occupied === true ? 'Occupied' : 'Vacant';
    }
    if (record.checkOut === undefined && input.checkoutDate != null) {
      record.checkOut = input.checkoutDate instanceof Date ? input.checkoutDate.toISOString().slice(0, 10) : String(input.checkoutDate);
    }
  }
  const numberField = housekeeping ? 'roomNumber' : 'room';
  if (!partial || record[numberField] !== undefined) record[numberField] = normalizeRoomNumber(record[numberField]);
  for (const field of TEXT_FIELDS) {
    if (record[field] !== undefined) {
      if (record[field] === null) record[field] = '';
      if (typeof record[field] !== 'string') throw invalid(`${field} must be text`);
      if (record[field].length > 4000) throw invalid(`${field} must be at most 4000 characters`);
      record[field] = record[field].trim();
    }
  }
  if (!partial && record.housekeepingStatus === undefined) record.housekeepingStatus = 'Dirty';
  if (!partial && record.occupancyStatus === undefined) record.occupancyStatus = 'Vacant';
  if (record.housekeepingStatus !== undefined) record.housekeepingStatus = normalizeHousekeepingStatus(record.housekeepingStatus);
  if (record.occupancyStatus !== undefined) record.occupancyStatus = normalizeOccupancyStatus(record.occupancyStatus);
  if (imported && housekeeping) {
    for (const [flag, expected] of [
      ['clean', record.housekeepingStatus === 'Clean'], ['dirty', record.housekeepingStatus === 'Dirty'],
      ['occupied', record.occupancyStatus === 'Occupied'], ['vacant', record.occupancyStatus === 'Vacant']
    ]) {
      if (input[flag] !== undefined && input[flag] !== expected) throw invalid(`${flag} conflicts with the room status`);
    }
  }
  if (record.pet !== undefined && typeof record.pet !== 'boolean') throw invalid('pet must be true or false');
  if (reportDate !== undefined) record.reportDate = parseReportDate(reportDate);
  else if (!partial || record.reportDate !== undefined) record.reportDate = parseReportDate(record.reportDate);
  for (const field of ['cleanedAt', 'inspectedAt', 'stayoverServicedAt']) {
    if (record[field] !== undefined && record[field] !== null) {
      const date = new Date(record[field]);
      if ((typeof record[field] !== 'string' && !(imported && record[field] instanceof Date)) || Number.isNaN(date.getTime())) throw invalid(`${field} must be a valid date or null`);
      record[field] = date;
    }
  }
  for (const field of ['issues', 'photos']) {
    if (record[field] !== undefined && (!Array.isArray(record[field]) || record[field].length > 100 || record[field].some(value => typeof value !== 'string' || value.length > 4000))) {
      throw invalid(`${field} must be an array of up to 100 text entries`);
    }
  }
  if (partial && !Object.keys(record).length) throw invalid('At least one editable field is required');
  return record;
}

function emitMutation(req, event, payload) {
  // A disconnected socket must never turn a successful database write into an HTTP failure.
  try { req.app?.get('io')?.emit(event, payload); } catch (error) {
    console.error(`Could not notify clients of ${event}:`, error.message);
  }
}

function sendError(res, error, message) {
  const status = error.status || (['ValidationError', 'CastError'].includes(error.name) ? 400 : error.code === 11000 ? 409 : 500);
  if (status === 500) console.error(message, error.message);
  return res.status(status).json({ success: false, message: status === 500 ? message : error.message });
}

module.exports = {
  HOUSEKEEPING_STATUSES, OCCUPANCY_STATUSES, invalid, recordChanged, expectedVersion, assertExpectedVersion, parseReportDate, dateRange,
  normalizeRoomNumber, normalizeHousekeepingStatus, normalizeOccupancyStatus,
  normalizeFields, isOutOfOrder, isRoomUnavailable, assertStaffCanClean, emitMutation, sendError
};
