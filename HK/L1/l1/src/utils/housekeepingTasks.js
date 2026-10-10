import { isReportDate, isRoomUnavailable, localDate, normalizedStayDate, roomStatus } from './roomData';

function taskDate(room, selectedDate) {
  const reportDate = room.reportDate instanceof Date
    ? (!Number.isNaN(room.reportDate.getTime()) ? room.reportDate.toISOString().slice(0, 10) : '')
    : String(room.reportDate || '').slice(0, 10);
  if (isReportDate(reportDate)) return reportDate;
  if (isReportDate(selectedDate)) return selectedDate;
  return localDate();
}

function guestStatus(room) {
  return String(room.guestStatus || '').trim().toLowerCase().replace(/[\s_-]+/g, ' ');
}

// A scheduled departure does not mean the guest has checked out. Only vacant
// rooms enter the checkout-cleaning queue; occupied departures wait for the desk.
export function isContinuingStay(room, selectedDate) {
  if (room.occupancyStatus !== 'Occupied') return false;
  const status = guestStatus(room);
  if (/^(?:due\s*out|checked\s*out)\b/.test(status)) return false;
  const date = taskDate(room, selectedDate);
  const checkout = normalizedStayDate(room.checkOut, date);
  if (checkout) return checkout > date;
  return status === 'stay over' || status === 'stayover';
}

export function isStayoverRoom(room, selectedDate) {
  return !isRoomUnavailable(room) && isContinuingStay(room, selectedDate);
}

// The desk still needs to check departing guests out of blocked rooms. Their
// cleaning restrictions remain visible and are preserved by checkout.
export function frontdeskWorkflow(room, selectedDate) {
  if (room.occupancyStatus === 'Occupied' && !isContinuingStay(room, selectedDate)) return 'waiting';
  if (isRoomUnavailable(room)) return 'unavailable';
  if (isContinuingStay(room, selectedDate)) return 'stayover';
  if (room.occupancyStatus === 'Vacant') return roomStatus(room) === 'Clean' ? 'done' : 'ready';
  return 'unavailable';
}

export function housekeepingTask(room, selectedDate) {
  if (isRoomUnavailable(room)) return 'unavailable';
  if (room.occupancyStatus === 'Vacant') return roomStatus(room) === 'Clean' ? 'done' : 'ready';
  if (room.occupancyStatus !== 'Occupied') return 'unavailable';
  if (!isStayoverRoom(room, selectedDate)) return 'waiting';
  const servicedAt = room.stayoverServicedAt;
  return servicedAt && !Number.isNaN(new Date(servicedAt).getTime()) ? 'done' : 'stayover';
}

export function housekeepingTaskCounts(rooms, selectedDate) {
  const counts = { all: rooms.length, ready: 0, stayover: 0, waiting: 0, done: 0, unavailable: 0, actionable: 0 };
  rooms.forEach(room => { counts[housekeepingTask(room, selectedDate)] += 1; });
  counts.actionable = counts.ready + counts.stayover + counts.done;
  return counts;
}
