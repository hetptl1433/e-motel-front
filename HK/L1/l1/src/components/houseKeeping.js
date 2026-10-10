import React, { useContext, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';
import { AuthContext } from '../context/authContext';
import DateSelector, { useReportDate } from './DateSelector';
import useDatedRooms from '../hooks/useDatedRooms';
import useRoomRealtime from '../hooks/useRoomRealtime';
import { requestError, roomNumber, roomStatus, roomWorkflow, sortRooms } from '../utils/roomData';
import { LiveConnection, WorkflowFilters, WorkflowLegend, WorkflowStatus, workflowCounts, WORKFLOW_LABELS } from './RoomWorkflow';

export default function HouseKeeping() {
  const { user } = useContext(AuthContext);
  const canUpdate = ['housekeeping', 'admin'].includes(user?.role);
  const canImport = ['frontdesk', 'admin'].includes(user?.role);
  const [selectedDate, setSelectedDate] = useReportDate();
  const { rooms, setRooms, loading, error, refresh } = useDatedRooms('/housekeeper', selectedDate);
  const connected = useRoomRealtime({ date: selectedDate, setRooms, refresh });
  const pendingIds = useRef(new Set());
  const [pending, setPending] = useState({});
  const [updateError, setUpdateError] = useState('');
  const [notice, setNotice] = useState(null);
  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [attendantFilter, setAttendantFilter] = useState('all');

  const attendants = useMemo(() => [...new Set(rooms.map(room => room.assignedAttendant).filter(Boolean))].sort(), [rooms]);
  const sortedRooms = useMemo(() => sortRooms(rooms).filter(room => {
    if (statusFilter !== 'all' && roomWorkflow(room) !== statusFilter) return false;
    if (!roomNumber(room).toLowerCase().includes(search.trim().toLowerCase())) return false;
    if (attendantFilter === 'unassigned' && room.assignedAttendant) return false;
    if (attendantFilter !== 'all' && attendantFilter !== 'unassigned' && room.assignedAttendant !== attendantFilter) return false;
    return true;
  }), [rooms, statusFilter, search, attendantFilter]);
  const busy = Object.keys(pending).length > 0;
  const counts = workflowCounts(rooms);
  const displayDate = new Date(`${selectedDate}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const undoRoom = notice?.roomId ? rooms.find(room => room._id === notice.roomId && roomWorkflow(room) === 'done') : null;

  const updateStatus = async (room, undo = false) => {
    if (!canUpdate || roomWorkflow(room) !== (undo ? 'done' : 'ready') || pendingIds.current.has(room._id)) return;
    pendingIds.current.add(room._id);
    setPending(previous => ({ ...previous, [room._id]: true }));
    setUpdateError('');
    setNotice(null);
    try {
      const { data } = await api.put(`/housekeeper/${room._id}`, { housekeepingStatus: undo ? 'Dirty' : 'Clean' });
      const updated = data.data || data;
      setRooms(previous => previous.map(record => record._id === room._id ? { ...record, ...updated } : record));
      setNotice({ message: undo ? `Room ${roomNumber(room)} is ready to clean again.` : `Room ${roomNumber(room)} is done.${data.warning ? '' : ' Front desk has been updated.'}`, roomId: undo ? null : room._id });
      if (data.warning) setUpdateError(data.warning);
    } catch (cause) {
      setUpdateError(requestError(cause, `Room ${roomNumber(room)} was not saved. Please try again.`));
      refresh();
    } finally {
      pendingIds.current.delete(room._id);
      setPending(previous => {
        const next = { ...previous };
        delete next[room._id];
        return next;
      });
    }
  };

  const resetFilters = () => { setStatusFilter('all'); setSearch(''); setAttendantFilter('all'); };
  return (
    <div className="room-page housekeeping-page">
      <div className="page-heading">
        <div><h1>Housekeeping</h1>
          <p>{canUpdate ? 'Clean a ready room, then tap Mark done.' : 'Room status updates here as housekeeping finishes.'}</p>
        </div>
        <LiveConnection connected={connected} error={error} />
      </div>
      <div className="cleaning-progress">
        <div><strong>Cleaning progress</strong><span>{counts.done} of {counts.all} done</span></div>
        <progress aria-label="Rooms completed" value={counts.done} max={counts.all || 1} />
        <p>{counts.ready} ready to clean · {counts.waiting} waiting for checkout</p>
      </div>
      <label className="room-search" htmlFor="housekeeping-room-filter"><span>Find a room</span><input id="housekeeping-room-filter" type="search" placeholder="Room number…" value={search} onChange={event => setSearch(event.target.value)} /></label>
      <WorkflowFilters rooms={rooms} value={statusFilter} onChange={setStatusFilter} />
      <details className="board-options mb-5">
        <summary>More filters and report date <span className="options-date">· {displayDate}</span></summary>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 p-4">

          <div><label htmlFor="housekeeping-attendant-filter" className="block text-sm font-medium mb-1">Assigned attendant</label><select id="housekeeping-attendant-filter" value={attendantFilter} onChange={event => setAttendantFilter(event.target.value)} className="w-full px-3 py-3 border border-gray-300 rounded-lg bg-white"><option value="all">All attendants</option><option value="unassigned">Unassigned</option>{attendants.map(name => <option key={name} value={name}>{name}</option>)}</select></div>
          <div className="sm:col-span-2 flex flex-wrap gap-4 items-center justify-between"><DateSelector date={selectedDate} onChange={date => { setSelectedDate(date); setNotice(null); setUpdateError(''); }} disabled={busy} /><button type="button" disabled={loading || busy} onClick={refresh} className="px-3 py-3 border border-gray-300 bg-white rounded-lg disabled:opacity-50">Refresh rooms</button></div>
        </div>
      </details>
      {updateError ? <div role="alert" className="mb-4 p-4 bg-red-50 border border-red-200 text-red-800 rounded-lg">{updateError}</div> : null}
      {notice ? <div role="status" className="mb-4 p-4 bg-green-50 text-green-900 rounded-lg flex flex-wrap items-center justify-between gap-3"><span>{notice.message}</span>{undoRoom ? <button type="button" onClick={() => updateStatus(undoRoom, true)} disabled={busy} className="rounded-lg border border-green-700 px-4 py-3 font-semibold">Undo room {roomNumber(undoRoom)}</button> : null}</div> : null}
      {error ? <div role="alert" className="mb-4 p-4 bg-red-50 border border-red-200 text-red-800 rounded-lg"><p>{error}</p><button type="button" onClick={refresh} className="underline font-medium mt-2">Try again</button></div> : null}
      {loading ? <p role="status" className="py-3 text-center text-gray-600">{rooms.length ? 'Refreshing rooms…' : 'Loading rooms…'}</p> : null}
      {(!loading || rooms.length > 0) && (!error || rooms.length > 0) ? <>
        {rooms.length === 0 ? <div className="empty-state"><h2 className="font-semibold text-lg">No rooms for {selectedDate}</h2><p className="text-gray-600 mt-2">{canImport ? 'Upload the morning PDF to get started.' : 'The front desk needs to upload the morning PDF.'}</p>{canImport ? <Link to={`/upload-report?date=${selectedDate}`} className="inline-block mt-3 text-blue-700 font-medium underline">Upload PDF</Link> : null}</div>
          : sortedRooms.length === 0 ? <div className="empty-state"><h2 className="font-semibold">No rooms match these filters</h2><button type="button" onClick={resetFilters} className="mt-3 px-4 py-3 text-blue-700 underline">Show all rooms</button></div>
          : <><div className="room-list-heading"><h2>Room list</h2><p aria-live="polite">{sortedRooms.length} {sortedRooms.length === 1 ? 'room' : 'rooms'} · {displayDate}</p></div><div className="housekeeping-grid">{sortedRooms.map(room => {
            const workflow = roomWorkflow(room);
            const saving = Boolean(pending[room._id]);
            return <article key={room._id} className={`cleaning-tile workflow-${workflow} ${room.pet ? 'pet-tile' : ''}`} aria-label={`Room ${roomNumber(room)}, ${WORKFLOW_LABELS[workflow]}`} aria-busy={saving}>
              <div className="tile-heading"><div><h3 className="tile-number">{roomNumber(room)}</h3>{room.type ? <span className="tile-type">{room.type}</span> : null}</div><WorkflowStatus workflow={workflow} /></div>
              <div className="tile-details">
                {workflow === 'waiting' ? <span className="tile-help tile-instruction">Guest still in room</span> : null}
                {workflow === 'unavailable' ? <span className="tile-help tile-instruction">{roomStatus(room)}</span> : null}
                {room.pet ? <span className="tile-help pet-notice">Pet in room</span> : null}
                {room.assignedAttendant ? <span className="tile-help tile-attendant">{room.assignedAttendant}</span> : null}
                {[room.notes, room.reason, room.description].filter(Boolean).map((note, index) => <p key={index} className="tile-note">{note}</p>)}
              </div>
              {canUpdate && workflow === 'ready' ? <button type="button" onClick={() => updateStatus(room)} disabled={saving} className="tile-action" aria-label={`Mark room ${roomNumber(room)} done`}>{saving ? 'Saving…' : 'Mark done'}</button>
                : <span className="tile-footer">{workflow === 'done' ? '✓ Clean' : workflow === 'waiting' ? 'Wait for front desk' : workflow === 'ready' ? 'Housekeeping will clean' : 'Do not clean'}</span>}
            </article>;
          })}</div></>}
      </> : null}
      <WorkflowLegend />
    </div>
  );
}
