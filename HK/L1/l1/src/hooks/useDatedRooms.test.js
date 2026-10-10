import { act, renderHook, waitFor } from '@testing-library/react';
import api from '../api';
import useDatedRooms from './useDatedRooms';

jest.mock('../api', () => ({ __esModule: true, default: { get: jest.fn() } }));

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

const response = rooms => ({ data: { data: rooms } });
const room = { _id: 'room-101', roomNumber: '101', housekeepingStatus: 'Dirty' };

beforeEach(() => jest.clearAllMocks());

test('a late HTTP refresh preserves a newer live/save update and requests current rooms', async () => {
  const stale = deferred();
  const current = deferred();
  api.get.mockResolvedValueOnce(response([room]))
    .mockReturnValueOnce(stale.promise)
    .mockReturnValueOnce(current.promise);
  const { result } = renderHook(() => useDatedRooms('/housekeeper', '2026-10-03'));
  await waitFor(() => expect(result.current.loading).toBe(false));

  act(() => result.current.refresh());
  await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
  act(() => result.current.setRooms(rooms => rooms.map(value => ({ ...value, housekeepingStatus: 'Clean' }))));
  await act(async () => stale.resolve(response([room])));

  expect(result.current.rooms[0].housekeepingStatus).toBe('Clean');
  await waitFor(() => expect(api.get).toHaveBeenCalledTimes(3));
  await act(async () => current.resolve(response([{ ...room, housekeepingStatus: 'Clean', notes: 'Ready' }])));
  expect(result.current.rooms[0].notes).toBe('Ready');
  expect(result.current.loading).toBe(false);
});

test('a live update arriving before the first HTTP snapshot remains visible', async () => {
  const stale = deferred();
  const current = deferred();
  api.get.mockReturnValueOnce(stale.promise).mockReturnValueOnce(current.promise);
  const { result } = renderHook(() => useDatedRooms('/housekeeper', '2026-10-03'));
  const cleaned = { ...room, housekeepingStatus: 'Clean' };
  act(() => result.current.setRooms([cleaned]));
  await act(async () => stale.resolve(response([room])));
  expect(result.current.rooms).toEqual([cleaned]);
  await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
  await act(async () => current.resolve(response([cleaned])));
  expect(result.current.loading).toBe(false);
});

test('changing dates aborts older reads and ignores a previous date save callback', async () => {
  const older = deferred();
  api.get.mockReturnValueOnce(older.promise).mockResolvedValueOnce(response([{ ...room, _id: 'new-day' }]));
  const { result, rerender } = renderHook(({ date }) => useDatedRooms('/housekeeper', date), {
    initialProps: { date: '2026-10-02' }
  });
  const oldSetRooms = result.current.setRooms;
  const firstSignal = api.get.mock.calls[0][1].signal;
  rerender({ date: '2026-10-03' });
  await waitFor(() => expect(result.current.rooms[0]?._id).toBe('new-day'));

  act(() => oldSetRooms([{ ...room, _id: 'old-save' }]));
  await act(async () => older.resolve(response([{ ...room, _id: 'old-fetch' }])));
  expect(firstSignal.aborted).toBe(true);
  expect(result.current.rooms[0]._id).toBe('new-day');
  expect(api.get).toHaveBeenCalledTimes(2);
});

test('an older save response cannot overwrite another staff member\'s newer live update', async () => {
  api.get.mockResolvedValueOnce(response([{ ...room, updatedAt: '2026-10-03T12:00:00.000Z' }]));
  const { result } = renderHook(() => useDatedRooms('/housekeeper', '2026-10-03'));
  await waitFor(() => expect(result.current.loading).toBe(false));
  const newest = { ...room, housekeepingStatus: 'Clean', updatedAt: '2026-10-03T12:00:02.000Z' };
  act(() => result.current.setRooms([newest]));
  act(() => result.current.setRooms(rooms => rooms.map(value => ({ ...value, housekeepingStatus: 'Dirty', updatedAt: '2026-10-03T12:00:01.000Z' }))));
  expect(result.current.rooms).toEqual([newest]);
});
