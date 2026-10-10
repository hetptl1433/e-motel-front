import { useContext, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { AuthContext } from '../context/authContext';
import { SOCKET_OPTIONS, SOCKET_URL } from '../api';

const housekeepingEvents = ['housekeepingStatusUpdated', 'housekeepingBulkUpdated', 'housekeepingRecordCreated', 'housekeepingRecordDeleted', 'housekeepingDataImported', 'housekeepingArrayImported'];
const dashboardEvents = ['roomStatusUpdated', 'roomDataUpdated', 'roomRecordCreated'];
const incrementalBulkActions = new Set(['bulkUpdate', 'roomUpdate', 'checkout']);

const reportDate = value => typeof value === 'string' ? value.slice(0, 10) : '';
const isRecord = value => value && typeof value === 'object' && !Array.isArray(value) && typeof value._id === 'string' && value._id.length > 0;
const hasRoomNumber = value => value.room != null || value.roomNumber != null;

function mergeRecord(existing, incoming) {
  const currentTime = Date.parse(existing.updatedAt);
  const incomingTime = Date.parse(incoming.updatedAt);
  // Saves and socket notifications can finish in a different order. A partial
  // or older notification must not replace a record whose version is known.
  if (Number.isFinite(currentTime) && (!Number.isFinite(incomingTime) || incomingTime < currentTime)) return existing;
  return { ...existing, ...incoming };
}

export default function useRoomRealtime({ date, setRooms, refresh, dashboard = false }) {
  const { token } = useContext(AuthContext);
  const [connection, setConnection] = useState({ token: null, connected: false });
  const latest = useRef({ date, setRooms, refresh });
  latest.current = { date, setRooms, refresh };

  useEffect(() => {
    const setConnected = connected => setConnection({ token, connected });
    setConnected(false);
    if (!token) return;
    let active = true;
    const socket = io(SOCKET_URL, {
      ...SOCKET_OPTIONS,
      autoConnect: false,
      auth: { token },
      withCredentials: true
    });
    const events = dashboard ? dashboardEvents : housekeepingEvents;
    const handleUpdate = payload => {
      if (!active || !payload) return;
      const { date, setRooms, refresh } = latest.current;
      const eventDate = reportDate(payload.date || payload.data?.reportDate);
      if (eventDate && eventDate !== date) return;
      const bulk = Array.isArray(payload.data);
      if (payload.action === 'create' || (bulk && !incrementalBulkActions.has(payload.action))) {
        refresh();
        return;
      }
      const incoming = bulk ? payload.data : [payload.data];
      let needsRefresh = incoming.length === 0;
      const records = incoming.filter(record => {
        if (!isRecord(record)) { needsRefresh = true; return false; }
        const recordDate = reportDate(record.reportDate) || eventDate;
        if (!recordDate) { needsRefresh = true; return false; }
        return recordDate === date;
      });
      if (!records.length) {
        if (needsRefresh) refresh();
        return;
      }
      if (payload.action === 'delete') {
        const removed = new Set(records.map(record => record._id));
        setRooms(previous => previous.filter(room => !removed.has(room._id)));
      } else {
        const updates = new Map();
        records.forEach(record => updates.set(record._id, updates.has(record._id) ? mergeRecord(updates.get(record._id), record) : record));
        setRooms(previous => {
          const existing = new Set(previous.map(room => room._id));
          const merged = previous.map(room => updates.has(room._id) ? mergeRecord(room, updates.get(room._id)) : room);
          // A notification can beat the initial HTTP snapshot. Complete server
          // records can appear immediately; unknown partial records need a read.
          return [...merged, ...[...updates.values()].filter(record => !existing.has(record._id) && hasRoomNumber(record))];
        });
        if (records.some(record => !hasRoomNumber(record))) needsRefresh = true;
      }
      if (needsRefresh) refresh();
    };
    socket.on('connect', () => {
      if (active) { setConnected(navigator.onLine !== false); latest.current.refresh(); }
    });
    const disconnected = () => { if (active) setConnected(false); };
    socket.on('disconnect', disconnected);
    socket.on('connect_error', disconnected);
    events.forEach(event => socket.on(event, handleUpdate));
    const resync = () => {
      if (!active || navigator.onLine === false) return;
      setConnected(socket.connected);
      latest.current.refresh();
      // Phones can suspend a connection while the page is in the background.
      // Explicitly reconnect when returning, including a server disconnect.
      if (!socket.connected) socket.connect();
    };
    const offline = () => { if (active) setConnected(false); };
    const visible = () => { if (document.visibilityState === 'visible') resync(); };
    window.addEventListener('online', resync);
    window.addEventListener('offline', offline);
    window.addEventListener('focus', resync);
    document.addEventListener('visibilitychange', visible);
    // StrictMode can discard a mount immediately. Let its cleanup cancel the
    // connection before opening a transport, then attach listeners first.
    const connectTimer = window.setTimeout(() => { if (active) socket.connect(); }, 0);
    // Keep the board current when live updates are temporarily unavailable.
    const poll = window.setInterval(() => {
      if (!socket.connected && active && navigator.onLine !== false) {
        latest.current.refresh();
        // A server disconnect disables Socket.IO's automatic reconnection.
        // Retry at the polling interval so recovered infrastructure can restore
        // live updates without requiring a tab switch or a browser refresh.
        socket.connect();
      }
    }, 30000);
    return () => {
      active = false;
      window.clearTimeout(connectTimer);
      window.clearInterval(poll);
      window.removeEventListener('online', resync);
      window.removeEventListener('offline', offline);
      window.removeEventListener('focus', resync);
      document.removeEventListener('visibilitychange', visible);
      socket.disconnect();
    };
  }, [token, dashboard]);

  return connection.token === token && connection.connected;
}
