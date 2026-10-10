import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../api';
import { extractRooms, mergeRoomRecord, requestError } from '../utils/roomData';

export default function useDatedRooms(endpoint, date) {
  const [snapshot, setSnapshot] = useState({ date: '', rooms: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const mutationRevision = useRef(0);
  const scope = `${endpoint}:${date}`;
  const activeScope = useRef(scope);
  activeScope.current = scope;
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  const setRooms = useCallback(next => {
    // A save from the previous date may finish after navigation. Keep its
    // response out of the current board and invalidate older reads immediately.
    if (activeScope.current !== scope) return;
    mutationRevision.current += 1;
    setSnapshot(previous => {
      const current = previous.date === date ? previous.rooms : [];
      const proposed = typeof next === 'function' ? next(current) : next;
      const currentById = new Map(current.map(room => [room._id, room]));
      return {
        date,
        rooms: proposed.map(room => {
          const existing = currentById.get(room._id);
          // Another staff member's socket update can beat this client's older
          // save response. Server timestamps identify the more recent record.
          return mergeRoomRecord(existing, room);
        })
      };
    });
  }, [date, scope]);

  useEffect(() => {
    const controller = new AbortController();
    const requestRevision = mutationRevision.current;
    let superseded = false;
    setLoading(true);
    setError('');
    api.get(endpoint, { params: { date }, signal: controller.signal })
      .then(response => {
        if (controller.signal.aborted) return;
        if (requestRevision !== mutationRevision.current) {
          // An HTTP snapshot started before a live update/save can arrive last.
          // Preserve the newer board and fetch a complete current snapshot.
          superseded = true;
          refresh();
          return;
        }
        setSnapshot({ date, rooms: extractRooms(response.data) });
      })
      .catch(cause => {
        if (!controller.signal.aborted) setError(requestError(cause, 'Unable to load rooms. Please try again.'));
      })
      .finally(() => {
        if (!controller.signal.aborted && !superseded) setLoading(false);
      });
    return () => controller.abort();
  }, [endpoint, date, revision, refresh]);

  const rooms = snapshot.date === date ? snapshot.rooms : [];
  return { rooms, setRooms, loading, error, refresh };
}
