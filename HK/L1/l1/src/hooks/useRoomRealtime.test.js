import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { io } from 'socket.io-client';
import { AuthContext } from '../context/authContext';
import { SOCKET_OPTIONS } from '../api';
import useRoomRealtime from './useRoomRealtime';

jest.mock('socket.io-client', () => ({ io: jest.fn() }));
jest.mock('../api', () => ({ __esModule: true, default: {}, SOCKET_URL: 'https://motel.vercel.app', SOCKET_OPTIONS: { path: '/socket.io', transports: ['websocket'] } }));

function createSocket() {
  const listeners = new Map();
  return {
    connected: false,
    on: jest.fn((event, handler) => { listeners.set(event, handler); }),
    connect: jest.fn(),
    disconnect: jest.fn(),
    receive(event, payload) { listeners.get(event)?.(payload); }
  };
}

const wrapper = ({ children }) => <AuthContext.Provider value={{ token: 'staff-session' }}>{children}</AuthContext.Provider>;
let sockets;

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  SOCKET_OPTIONS.transports = ['websocket'];
  sockets = [];
  io.mockImplementation(() => {
    const socket = createSocket();
    sockets.push(socket);
    return socket;
  });
});
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

test('reconnect refreshes missed updates and disconnected polling stops while connected', () => {
  const refresh = jest.fn();
  const setRooms = jest.fn();
  const { result, unmount } = renderHook(() => useRoomRealtime({ date: '2026-10-03', setRooms, refresh }), { wrapper });
  const socket = sockets[0];
  act(() => jest.advanceTimersByTime(0));
  expect(socket.connect).toHaveBeenCalledTimes(1);
  expect(io).toHaveBeenCalledWith('https://motel.vercel.app', expect.objectContaining({ auth: { token: 'staff-session' }, path: '/socket.io', transports: ['websocket'] }));

  act(() => { socket.connected = true; socket.receive('connect'); });
  expect(result.current).toBe(true);
  expect(refresh).toHaveBeenCalledTimes(1);
  act(() => { socket.connected = false; socket.receive('disconnect'); });
  expect(result.current).toBe(false);
  act(() => jest.advanceTimersByTime(30000));
  expect(refresh).toHaveBeenCalledTimes(2);
  act(() => { socket.connected = true; socket.receive('connect'); });
  expect(refresh).toHaveBeenCalledTimes(3);
  act(() => jest.advanceTimersByTime(30000));
  expect(refresh).toHaveBeenCalledTimes(3);
  unmount();
  expect(socket.disconnect).toHaveBeenCalledTimes(1);
});

test('local configured polling transport still upgrades to WebSocket', () => {
  SOCKET_OPTIONS.transports = ['polling', 'websocket'];
  renderHook(() => useRoomRealtime({ date: '2026-10-03', setRooms: jest.fn(), refresh: jest.fn() }), { wrapper });
  expect(io).toHaveBeenCalledWith('https://motel.vercel.app', expect.objectContaining({ path: '/socket.io', transports: ['polling', 'websocket'], autoConnect: false, withCredentials: true }));
});

test('server-disconnected clients retry on the bounded poll interval and stop once live', () => {
  const refresh = jest.fn();
  const { result, unmount } = renderHook(() => useRoomRealtime({ date: '2026-10-03', setRooms: jest.fn(), refresh }), { wrapper });
  const socket = sockets[0];
  act(() => jest.advanceTimersByTime(0));
  act(() => { socket.connected = true; socket.receive('connect'); });
  act(() => { socket.connected = false; socket.receive('disconnect', 'io server disconnect'); });
  expect(result.current).toBe(false);
  expect(socket.connect).toHaveBeenCalledTimes(1);
  act(() => jest.advanceTimersByTime(29999));
  expect(socket.connect).toHaveBeenCalledTimes(1);
  act(() => jest.advanceTimersByTime(1));
  expect(socket.connect).toHaveBeenCalledTimes(2);
  expect(refresh).toHaveBeenCalledTimes(2);
  act(() => { socket.connected = true; socket.receive('connect'); });
  expect(result.current).toBe(true);
  act(() => jest.advanceTimersByTime(60000));
  expect(socket.connect).toHaveBeenCalledTimes(2);
  expect(refresh).toHaveBeenCalledTimes(3);
  unmount();
  act(() => jest.advanceTimersByTime(60000));
  expect(socket.connect).toHaveBeenCalledTimes(2);
});

test('updates stay on the selected date and an arriving room can appear before the initial snapshot', () => {
  const refresh = jest.fn();
  let rooms = [{ _id: '101', roomNumber: '101', housekeepingStatus: 'Dirty' }];
  const setRooms = next => { rooms = next(rooms); };
  renderHook(() => useRoomRealtime({ date: '2026-10-03', setRooms, refresh }), { wrapper });
  const socket = sockets[0];
  act(() => socket.receive('housekeepingStatusUpdated', { date: '2026-10-02', data: { _id: '101', housekeepingStatus: 'Clean' } }));
  expect(rooms[0].housekeepingStatus).toBe('Dirty');
  act(() => socket.receive('housekeepingStatusUpdated', { date: '2026-10-03', data: { _id: '101', roomNumber: '101', housekeepingStatus: 'Clean' } }));
  expect(rooms[0].housekeepingStatus).toBe('Clean');
  act(() => socket.receive('housekeepingStatusUpdated', { date: '2026-10-03', data: { _id: '102', roomNumber: '102', housekeepingStatus: 'Dirty' } }));
  expect(rooms.map(room => room._id)).toEqual(['101', '102']);
  act(() => socket.receive('housekeepingBulkUpdated', { date: '2026-10-03', data: [] }));
  expect(refresh).toHaveBeenCalledTimes(1);
});

test('new dashboard rooms refresh the report and foreground/online events resync suspended phones', () => {
  const refresh = jest.fn();
  const setRooms = jest.fn();
  const { unmount } = renderHook(() => useRoomRealtime({ date: '2026-10-03', setRooms, refresh, dashboard: true }), { wrapper });
  const socket = sockets[0];
  act(() => jest.advanceTimersByTime(0));
  act(() => socket.receive('roomRecordCreated', { action: 'create', date: '2026-10-03', data: { _id: '101' } }));
  expect(refresh).toHaveBeenCalledTimes(1);
  act(() => window.dispatchEvent(new Event('focus')));
  act(() => window.dispatchEvent(new Event('online')));
  expect(refresh).toHaveBeenCalledTimes(3);
  expect(socket.connect).toHaveBeenCalledTimes(3);
  unmount();
  act(() => window.dispatchEvent(new Event('focus')));
  expect(refresh).toHaveBeenCalledTimes(3);
});

test('changing dates and callbacks keeps the socket connected and uses the current board', () => {
  const originalRefresh = jest.fn();
  const originalSetRooms = jest.fn();
  const currentRefresh = jest.fn();
  const currentSetRooms = jest.fn();
  const { result, rerender } = renderHook(props => useRoomRealtime(props), {
    wrapper,
    initialProps: { date: '2026-10-03', setRooms: originalSetRooms, refresh: originalRefresh }
  });
  const socket = sockets[0];
  act(() => { socket.connected = true; socket.receive('connect'); });
  rerender({ date: '2026-10-04', setRooms: currentSetRooms, refresh: currentRefresh });
  expect(io).toHaveBeenCalledTimes(1);
  expect(socket.disconnect).not.toHaveBeenCalled();
  expect(result.current).toBe(true);

  act(() => socket.receive('housekeepingStatusUpdated', { date: '2026-10-03', data: { _id: 'old-day', roomNumber: '101' } }));
  expect(currentSetRooms).not.toHaveBeenCalled();
  act(() => socket.receive('housekeepingStatusUpdated', { date: '2026-10-04', data: { _id: 'new-day', roomNumber: '101' } }));
  expect(currentSetRooms).toHaveBeenCalledTimes(1);
  expect(originalSetRooms).not.toHaveBeenCalled();
  act(() => { socket.connected = false; socket.receive('disconnect'); jest.advanceTimersByTime(30000); });
  expect(currentRefresh).toHaveBeenCalledTimes(1);
});

test('dated bulk checkout and status updates appear immediately without adding other dates', () => {
  const refresh = jest.fn();
  let rooms = [{ _id: '101', roomNumber: '101', housekeepingStatus: 'Dirty', occupancyStatus: 'Occupied' }];
  const setRooms = next => { rooms = next(rooms); };
  renderHook(() => useRoomRealtime({ date: '2026-10-03', setRooms, refresh }), { wrapper });
  const socket = sockets[0];
  act(() => socket.receive('housekeepingBulkUpdated', {
    action: 'checkout', date: '2026-10-03',
    data: [{ _id: '101', roomNumber: '101', occupancyStatus: 'Vacant' }]
  }));
  expect(rooms[0].occupancyStatus).toBe('Vacant');
  act(() => socket.receive('housekeepingBulkUpdated', {
    action: 'bulkUpdate', data: [
      { _id: '101', roomNumber: '101', reportDate: '2026-10-03T00:00:00.000Z', housekeepingStatus: 'Clean' },
      { _id: '102', roomNumber: '102', reportDate: '2026-10-03T00:00:00.000Z', housekeepingStatus: 'Clean', updatedAt: '2026-10-03T12:00:02.000Z' },
      { _id: '102', roomNumber: '102', reportDate: '2026-10-03T00:00:00.000Z', housekeepingStatus: 'Dirty', updatedAt: '2026-10-03T12:00:01.000Z' },
      { _id: 'other-day', roomNumber: '103', reportDate: '2026-10-04T00:00:00.000Z', housekeepingStatus: 'Clean' }
    ]
  }));
  expect(rooms.map(room => room._id)).toEqual(['101', '102']);
  expect(rooms[0].housekeepingStatus).toBe('Clean');
  expect(rooms[1].housekeepingStatus).toBe('Clean');
  expect(refresh).not.toHaveBeenCalled();
});

test('late or unversioned updates cannot replace a newer server record', () => {
  const refresh = jest.fn();
  const newest = { _id: '101', room: '101', housekeepingStatus: 'Clean', updatedAt: '2026-10-03T12:00:02.000Z' };
  let rooms = [newest];
  const setRooms = next => { rooms = next(rooms); };
  renderHook(() => useRoomRealtime({ date: '2026-10-03', setRooms, refresh, dashboard: true }), { wrapper });
  const socket = sockets[0];
  act(() => socket.receive('roomStatusUpdated', {
    date: '2026-10-03', data: { ...newest, housekeepingStatus: 'Dirty', updatedAt: '2026-10-03T12:00:01.000Z' }
  }));
  act(() => socket.receive('roomStatusUpdated', { date: '2026-10-03', data: { _id: '101', room: '101', housekeepingStatus: 'Dirty' } }));
  expect(rooms).toEqual([newest]);
  act(() => socket.receive('roomStatusUpdated', {
    date: '2026-10-03', data: { ...newest, housekeepingStatus: 'Dirty', updatedAt: '2026-10-03T12:00:03.000Z' }
  }));
  expect(rooms[0].housekeepingStatus).toBe('Dirty');
});

test('ambiguous notifications refresh without inserting incomplete rooms, while deletes remove the matching record', () => {
  const refresh = jest.fn();
  let rooms = [{ _id: '101', roomNumber: '101', housekeepingStatus: 'Dirty' }];
  const setRooms = next => { rooms = next(rooms); };
  renderHook(() => useRoomRealtime({ date: '2026-10-03', setRooms, refresh }), { wrapper });
  const socket = sockets[0];
  act(() => socket.receive('housekeepingStatusUpdated', { date: '2026-10-03', data: { _id: 'unknown' } }));
  expect(rooms.map(room => room._id)).toEqual(['101']);
  expect(refresh).toHaveBeenCalledTimes(1);
  act(() => socket.receive('housekeepingStatusUpdated', { data: { _id: '101', roomNumber: '101', housekeepingStatus: 'Clean' } }));
  expect(rooms[0].housekeepingStatus).toBe('Dirty');
  expect(refresh).toHaveBeenCalledTimes(2);
  act(() => socket.receive('housekeepingRecordDeleted', { action: 'delete', date: '2026-10-03', data: { _id: '101' } }));
  expect(rooms).toEqual([]);
});

test('the connection indicator changes immediately when the browser goes offline and resyncs on return', () => {
  const refresh = jest.fn();
  const online = jest.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  const { result } = renderHook(() => useRoomRealtime({ date: '2026-10-03', setRooms: jest.fn(), refresh }), { wrapper });
  const socket = sockets[0];
  act(() => { socket.connected = true; socket.receive('connect'); });
  expect(result.current).toBe(true);
  online.mockReturnValue(false);
  act(() => window.dispatchEvent(new Event('offline')));
  expect(result.current).toBe(false);
  act(() => { socket.connected = false; jest.advanceTimersByTime(30000); window.dispatchEvent(new Event('focus')); });
  expect(refresh).toHaveBeenCalledTimes(1);
  online.mockReturnValue(true);
  act(() => window.dispatchEvent(new Event('online')));
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(socket.connect).toHaveBeenCalled();
  act(() => { socket.connected = true; socket.receive('connect'); });
  expect(result.current).toBe(true);
});

test('sign-out immediately clears live state and ignores notifications from the previous session', () => {
  let token = 'staff-session';
  const authWrapper = ({ children }) => <AuthContext.Provider value={{ token }}>{children}</AuthContext.Provider>;
  const refresh = jest.fn();
  const setRooms = jest.fn();
  const { result, rerender } = renderHook(() => useRoomRealtime({ date: '2026-10-03', setRooms, refresh }), { wrapper: authWrapper });
  const socket = sockets[0];
  act(() => { socket.connected = true; socket.receive('connect'); });
  expect(result.current).toBe(true);
  token = null;
  rerender();
  expect(result.current).toBe(false);
  expect(socket.disconnect).toHaveBeenCalledTimes(1);
  expect(io).toHaveBeenCalledTimes(1);
  act(() => socket.receive('housekeepingStatusUpdated', { date: '2026-10-03', data: { _id: '101', roomNumber: '101' } }));
  act(() => socket.receive('connect'));
  expect(setRooms).not.toHaveBeenCalled();
  expect(refresh).toHaveBeenCalledTimes(1);
});

test('StrictMode cancels the discarded transport before connecting and cleanup stops polling', () => {
  const refresh = jest.fn();
  const { unmount } = renderHook(() => useRoomRealtime({ date: '2026-10-03', setRooms: jest.fn(), refresh }), { wrapper, reactStrictMode: true });
  expect(sockets).toHaveLength(2);
  act(() => jest.advanceTimersByTime(0));
  expect(sockets[0].connect).not.toHaveBeenCalled();
  expect(sockets[1].connect).toHaveBeenCalledTimes(1);
  unmount();
  act(() => { jest.advanceTimersByTime(60000); window.dispatchEvent(new Event('online')); });
  expect(refresh).not.toHaveBeenCalled();
});
