import { housekeepingTask, housekeepingTaskCounts, isStayoverRoom } from './housekeepingTasks';

const reportDate = '2026-10-10';
const occupied = { reportDate, occupancyStatus: 'Occupied', housekeepingStatus: 'Dirty' };

test('only an actual vacant dirty room is ready for checkout cleaning', () => {
  expect(housekeepingTask({ ...occupied, checkOut: '2026-10-09', guestStatus: 'Checked-out' })).toBe('waiting');
  expect(housekeepingTask({ ...occupied, checkOut: reportDate, guestStatus: 'Stay Over' })).toBe('waiting');
  expect(housekeepingTask({ ...occupied, occupancyStatus: 'Vacant', guestStatus: 'Stay Over' })).toBe('ready');
  expect(housekeepingTask({ ...occupied, occupancyStatus: 'Vacant', housekeepingStatus: 'Clean' })).toBe('done');
  expect(housekeepingTask({ ...occupied, occupancyStatus: 'Unknown' })).toBe('unavailable');
});

test('future occupied stays need service even when their housekeeping status is already clean', () => {
  const room = { ...occupied, housekeepingStatus: 'Clean', checkOut: '2026-10-11' };
  expect(isStayoverRoom(room)).toBe(true);
  expect(housekeepingTask(room)).toBe('stayover');
  expect(isStayoverRoom({ ...room, occupancyStatus: 'Vacant' })).toBe(false);
});

test.each(['Due Out', 'due-out', '  DUE_OUT ', 'Dueout', 'Due-out (late checkout)', 'Checked-out', 'Checked out', 'Checkedout', 'Checked-out pending confirmation'])('explicit %s rooms wait for actual checkout despite a future date', guestStatus => {
  const room = { ...occupied, checkOut: '2026-10-11', guestStatus };
  expect(isStayoverRoom(room)).toBe(false);
  expect(housekeepingTask(room)).toBe('waiting');
});

test.each(['Stay Over', 'Stayover', '  STAY OVER  ', 'stay-over'])('explicit %s identifies a stayover when checkout is unknown', guestStatus => {
  expect(housekeepingTask({ ...occupied, checkOut: '', guestStatus })).toBe('stayover');
  expect(housekeepingTask({ ...occupied, checkOut: 'Unknown', guestStatus })).toBe('stayover');
});

test.each(['', 'In-house', 'Checked-out', 'Due Out'])('unknown checkout with status %s stays in the waiting queue', guestStatus => {
  expect(housekeepingTask({ ...occupied, guestStatus })).toBe('waiting');
});

test('legacy checkout dates resolve against the report year and the selected date fills a missing report date', () => {
  expect(housekeepingTask({ ...occupied, checkOut: 'October 11' })).toBe('stayover');
  expect(housekeepingTask({ ...occupied, checkOut: '10/10' })).toBe('waiting');
  expect(housekeepingTask({ ...occupied, checkOut: '10/11/25' })).toBe('waiting');
  expect(housekeepingTask({ ...occupied, reportDate: '2025-10-10', checkOut: 'October 11' }, reportDate)).toBe('stayover');
  expect(housekeepingTask({ ...occupied, reportDate: '2025-10-10T00:00:00.000Z', checkOut: '2025-10-11' }, reportDate)).toBe('stayover');
  expect(housekeepingTask({ ...occupied, reportDate: new Date('2025-10-10T00:00:00.000Z'), checkOut: '2025-10-11' }, reportDate)).toBe('stayover');
  expect(housekeepingTask({ ...occupied, reportDate: undefined, checkOut: '10/11' }, reportDate)).toBe('stayover');
  expect(housekeepingTask({ ...occupied, reportDate: 'invalid', checkOut: '10/10' }, reportDate)).toBe('waiting');
  expect(housekeepingTask({ ...occupied, reportDate: '2026-12-31', checkOut: '2027-01-01' })).toBe('stayover');
});

test('a valid service timestamp completes the stayover while retaining its service type', () => {
  const room = { ...occupied, checkOut: '2026-10-11', stayoverServicedAt: '2026-10-10T14:30:00.000Z' };
  expect(isStayoverRoom(room)).toBe(true);
  expect(housekeepingTask(room)).toBe('done');
  expect(housekeepingTask({ ...room, stayoverServicedAt: new Date(room.stayoverServicedAt) })).toBe('done');
  expect(housekeepingTask({ ...room, checkOut: reportDate })).toBe('waiting');
  expect(housekeepingTask({ ...room, occupancyStatus: 'Vacant' })).toBe('ready');
});

test.each([undefined, null, '', 'not a timestamp', false, 0])('invalid service timestamp %s does not complete a stayover', stayoverServicedAt => {
  expect(housekeepingTask({ ...occupied, checkOut: '2026-10-11', stayoverServicedAt })).toBe('stayover');
});

test.each([
  { housekeepingStatus: 'Maintenance' },
  { housekeepingStatus: 'Out of Order' },
  { orderStatus: 'Out of Service' },
  { orderStatus: 'OOI/OI' },
  { housekeepingStatus: undefined }
])('unavailable rooms override occupancy, dates, and completion', unavailable => {
  const room = { ...occupied, checkOut: '2026-10-11', stayoverServicedAt: '2026-10-10T14:30:00.000Z', ...unavailable };
  expect(isStayoverRoom(room)).toBe(false);
  expect(housekeepingTask(room)).toBe('unavailable');
  expect(housekeepingTask({ ...room, occupancyStatus: 'Vacant' })).toBe('unavailable');
});

test('task counts include each room once and track both outstanding and completed service work', () => {
  const rooms = [
    { ...occupied, occupancyStatus: 'Vacant' },
    { ...occupied, checkOut: '2026-10-11' },
    { ...occupied, checkOut: reportDate },
    { ...occupied, occupancyStatus: 'Vacant', housekeepingStatus: 'Clean' },
    { ...occupied, checkOut: '2026-10-11', stayoverServicedAt: '2026-10-10T14:30:00.000Z' },
    { ...occupied, housekeepingStatus: 'Maintenance' }
  ];
  expect(housekeepingTaskCounts(rooms)).toEqual({ all: 6, ready: 1, stayover: 1, waiting: 1, done: 2, unavailable: 1, actionable: 4 });
  expect(housekeepingTaskCounts([], reportDate)).toEqual({ all: 0, ready: 0, stayover: 0, waiting: 0, done: 0, unavailable: 0, actionable: 0 });
});
