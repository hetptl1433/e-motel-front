import { extractRooms, isReportDate, isRoomUnavailable, localDate, normalizedStayDate, roomStatus, shiftDate, sortRooms } from './roomData';

test('daily navigation preserves calendar days across DST and year boundaries', () => {
  expect(shiftDate('2026-03-08', 1)).toBe('2026-03-09');
  expect(shiftDate('2026-11-01', -1)).toBe('2026-10-31');
  expect(shiftDate('2026-12-31', 1)).toBe('2027-01-01');
  expect(localDate(new Date(2026, 9, 3, 23, 30))).toBe('2026-10-03');
});

test('report date validation rejects impossible dates and ambiguous formats', () => {
  expect(isReportDate('2024-02-29')).toBe(true);
  expect(isReportDate('2026-02-29')).toBe(false);
  expect(isReportDate('2026-02-30')).toBe(false);
  expect(isReportDate('10/03/2026')).toBe(false);
  expect(isReportDate('')).toBe(false);
});

test('legacy stay dates use the report year for date filters without accepting impossible dates', () => {
  expect(normalizedStayDate('May 22', '2025-05-22')).toBe('2025-05-22');
  expect(normalizedStayDate('10/3', '2026-10-03')).toBe('2026-10-03');
  expect(normalizedStayDate('05/22/25', '2026-10-03')).toBe('2025-05-22');
  expect(normalizedStayDate('2026-10-03T00:00:00.000Z', '2025-05-22')).toBe('2026-10-03');
  expect(normalizedStayDate('February 30', '2026-10-03')).toBe('');
  expect(normalizedStayDate('Due tomorrow', '2026-10-03')).toBe('');
});

test.each(['OOI/OI', 'OI, OOO', 'out-of-inventory', 'Out of Order (OTHER ISSUES)', 'Out of Service'])('order flag %s blocks a clean report room from housekeeping toggles', orderStatus => {
  const room = { housekeepingStatus: 'Clean', orderStatus };
  expect(roomStatus(room)).toBe('Out of Order');
  expect(isRoomUnavailable(room)).toBe(true);
});

test('maintenance stays unavailable, and clearing order status reopens a clean room', () => {
  expect(isRoomUnavailable({ housekeepingStatus: 'Maintenance' })).toBe(true);
  expect(roomStatus({ housekeepingStatus: 'Clean', orderStatus: '' })).toBe('Clean');
  expect(isRoomUnavailable({ housekeepingStatus: 'Dirty', orderStatus: '' })).toBe(false);
});

test('room lists support both API shapes and sort numeric room identifiers without mutating source data', () => {
  const rooms = [{ room: '110' }, { roomNumber: 9 }, { room: '102' }];
  expect(extractRooms({ success: true, data: rooms })).toBe(rooms);
  expect(extractRooms(rooms)).toBe(rooms);
  expect(sortRooms(rooms)).toEqual([rooms[1], rooms[2], rooms[0]]);
  expect(rooms.map(room => room.room || room.roomNumber)).toEqual(['110', 9, '102']);
  expect(() => extractRooms({ data: null })).toThrow('invalid room list');
});
