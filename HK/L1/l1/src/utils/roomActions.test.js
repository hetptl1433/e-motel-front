import { roomActionMatches, settleRoomActions } from './roomActions';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('limits requests to four, keeps room order, and continues after out-of-order failures', async () => {
  const rooms = Array.from({ length: 9 }, (_, index) => ({ _id: `room-${index}` }));
  const requests = rooms.map(() => deferred());
  const started = rooms.map(() => deferred());
  const firstFailure = new Error('Room 0 is now occupied');
  const laterFailure = new Error('Room 7 could not be reached');
  let active = 0;
  let peakActive = 0;
  const action = jest.fn(room => {
    const index = rooms.indexOf(room);
    active += 1;
    peakActive = Math.max(peakActive, active);
    started[index].resolve();
    return requests[index].promise.finally(() => { active -= 1; });
  });

  const batch = settleRoomActions(rooms, action);
  expect(action.mock.calls.map(([room]) => room._id)).toEqual(['room-0', 'room-1', 'room-2', 'room-3']);
  expect(active).toBe(4);

  requests[2].resolve('saved-2');
  await started[4].promise;
  expect(action).toHaveBeenCalledTimes(5);
  expect(active).toBe(4);

  requests[0].reject(firstFailure);
  await started[5].promise;
  expect(action).toHaveBeenCalledTimes(6);
  expect(active).toBe(4);

  requests[4].resolve('saved-4');
  await started[6].promise;
  requests[3].resolve('saved-3');
  await started[7].promise;
  requests[7].reject(laterFailure);
  await started[8].promise;
  expect(action).toHaveBeenCalledTimes(9);

  for (const index of [8, 6, 1, 5]) requests[index].resolve(`saved-${index}`);

  expect(await batch).toEqual([
    { status: 'rejected', reason: firstFailure },
    { status: 'fulfilled', value: 'saved-1' },
    { status: 'fulfilled', value: 'saved-2' },
    { status: 'fulfilled', value: 'saved-3' },
    { status: 'fulfilled', value: 'saved-4' },
    { status: 'fulfilled', value: 'saved-5' },
    { status: 'fulfilled', value: 'saved-6' },
    { status: 'rejected', reason: laterFailure },
    { status: 'fulfilled', value: 'saved-8' }
  ]);
  expect(peakActive).toBe(4);
  expect(active).toBe(0);
  expect(action.mock.calls.map(([room]) => room)).toEqual(rooms);
});

test('records a synchronous action failure without skipping the remaining rooms', async () => {
  const rooms = ['101', '102', '103', '104', '105'];
  const failure = new Error('Invalid room action');
  const action = jest.fn(room => {
    if (room === '101') throw failure;
    return Promise.resolve(`saved-${room}`);
  });

  expect(await settleRoomActions(rooms, action)).toEqual([
    { status: 'rejected', reason: failure },
    ...rooms.slice(1).map(room => ({ status: 'fulfilled', value: `saved-${room}` }))
  ]);
  expect(action).toHaveBeenCalledTimes(rooms.length);
});

test('an empty batch resolves without performing an action', async () => {
  const action = jest.fn();
  await expect(settleRoomActions([], action)).resolves.toEqual([]);
  expect(action).not.toHaveBeenCalled();
});

test('queued actions require the reviewed room version even if operational fields still match', () => {
  const original = { _id: '101', occupancyStatus: 'Occupied', checkOut: '2026-10-03', updatedAt: '2026-10-03T12:00:01.000Z' };
  const signature = room => `${room.occupancyStatus}:${room.checkOut}`;
  expect(roomActionMatches(original, { ...original, notes: 'Unchanged version' }, signature)).toBe(true);
  expect(roomActionMatches(original, { ...original, updatedAt: '2026-10-03T12:00:02.000Z' }, signature)).toBe(false);
  expect(roomActionMatches(original, { ...original, updatedAt: undefined }, signature)).toBe(false);
  expect(roomActionMatches(original, undefined, signature)).toBe(false);
  expect(roomActionMatches(original, { ...original, _id: '102' }, signature)).toBe(false);
});

test('unversioned queued actions still reject a changed guest stay or occupancy', () => {
  const original = { _id: '101', occupancyStatus: 'Occupied', checkOut: '2026-10-03' };
  const signature = room => `${room.occupancyStatus}:${room.checkOut}`;
  expect(roomActionMatches(original, { ...original, notes: 'Extra towels' }, signature)).toBe(true);
  expect(roomActionMatches(original, { ...original, checkOut: '2026-10-04' }, signature)).toBe(false);
  expect(roomActionMatches(original, { ...original, occupancyStatus: 'Vacant' }, signature)).toBe(false);
});
