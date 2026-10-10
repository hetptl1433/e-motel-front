import React, { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';
import { AuthContext } from '../context/authContext';
import DateSelector, { useReportDate } from './DateSelector';
import useDatedRooms from '../hooks/useDatedRooms';
import useRoomRealtime from '../hooks/useRoomRealtime';
import { HOUSEKEEPING_STATUSES, isRoomUnavailable, mergeRoomRecord, normalizedStayDate, requestError, roomNumber, roomStatus } from '../utils/roomData';
import { frontdeskWorkflow, housekeepingTask, isStayoverRoom } from '../utils/housekeepingTasks';
import { roomActionMatches, settleRoomActions } from '../utils/roomActions';
import { LiveConnection, WorkflowFilters, WorkflowLegend, WorkflowStatus, WorkflowSummary, WORKFLOW_LABELS } from './RoomWorkflow';
import RoomEditor, { DeskField as Field, ROOM_INPUT_CLASS as inputClass } from './RoomEditor';

const initialFilters = { status: 'all', occupancy: 'all', pet: 'all', dateType: 'none', start: '', end: '' };
const reportDateFormat = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
const stayDateFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const layoutStorageKey = 'motel.frontdesk.layout.v1';
const deskStatuses = ['waiting', 'ready', 'stayover', 'done', 'unavailable'];
const statusPriority = { waiting: 0, ready: 1, stayover: 2, done: 3, unavailable: 4 };
const checkoutFields = ['occupancyStatus', 'guestStatus', 'checkIn', 'checkOut', 'checkedOutAt', 'housekeepingStatus', 'orderStatus'];
const checkoutSignature = room => JSON.stringify([roomNumber(room), ...checkoutFields.map(field => room[field] ?? null)]);
const syncFields = [...checkoutFields, 'reportDate', 'stayoverServicedAt', 'cleanedAt', 'inspectedAt', 'notes', 'assignedAttendant', 'pet', 'reason', 'description'];
const syncSignature = room => JSON.stringify([roomNumber(room), ...syncFields.map(field => room[field] ?? null)]);
const guardedChanges = (room, changes = {}) => Number.isFinite(Date.parse(room.updatedAt))
  ? { ...changes, expectedUpdatedAt: room.updatedAt } : changes;

function savedLayout() {
  try { return window.localStorage.getItem(layoutStorageKey) === 'table' ? 'table' : 'boxes'; }
  catch { return 'boxes'; }
}

function editableValues(room, fullEdit, selectedDate) {
  return {
    housekeepingStatus: room.housekeepingStatus || 'Dirty', notes: room.notes || '',
    ...(fullEdit ? {
      pet: Boolean(room.pet), occupancyStatus: room.occupancyStatus || 'Vacant', guestStatus: room.guestStatus || '',
      checkIn: normalizedStayDate(room.checkIn, room.reportDate || selectedDate) || room.checkIn || '',
      checkOut: normalizedStayDate(room.checkOut, room.reportDate || selectedDate) || room.checkOut || '',
      assignedAttendant: room.assignedAttendant || '', orderStatus: room.orderStatus || '',
      reason: room.reason || '', description: room.description || ''
    } : {})
  };
}

function stayDates(room, reportDate) {
  const display = value => {
    const date = normalizedStayDate(value, room.reportDate || reportDate);
    return date ? stayDateFormat.format(new Date(`${date}T12:00:00`)) : value || '—';
  };
  return !room.checkIn && !room.checkOut ? '—' : `${display(room.checkIn)} – ${display(room.checkOut)}`;
}

// Housekeeping records stayover service separately; the desk sees whether it is done.
function occupancyLabel(room, reportDate) {
  if (isRoomUnavailable(room)) return roomStatus(room);
  if (isStayoverRoom(room, reportDate)) return `Stayover · Service ${housekeepingTask(room, reportDate) === 'done' ? 'done' : 'not done'}`;
  return room.occupancyStatus || 'Unknown';
}

function RoomDetails({ room, date }) {
  return <>
    <div className="desk-guest desk-cell"><small className="desk-mobile-label">Guest / stay</small><span>{room.guestStatus || '—'}</span><span className="desk-stay">{stayDates(room, date)}</span></div>
    <div className="desk-attendant desk-cell"><small className="desk-mobile-label">Attendant</small><span className={!room.assignedAttendant ? 'is-muted' : ''}>{room.assignedAttendant || 'Unassigned'}</span></div>
    <div className="desk-notes desk-cell"><small className="desk-mobile-label">Notes</small>{room.notes || room.description || room.reason ? <span>{[room.notes, room.reason, room.description].filter(Boolean).join(' · ')}</span> : !room.pet ? <span className="is-muted">—</span> : null}{room.pet ? <span className="pet-label">Pet in room</span> : null}</div>
  </>;
}

function DeskIcon({ name, className = '' }) {
  const paths = {
    upload: <><path d="M12 16V3m-5 5 5-5 5 5" /><path d="M4 14v6h16v-6" /></>,
    refresh: <><path d="M20 7v5h-5" /><path d="M19.2 7a8 8 0 1 0 .6 9" /></>,
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
    filters: <path d="m3 4 7 8v7l4 2v-9l7-8H3Z" />,
    table: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M3 14h18M9 4v16" /></>,
    boxes: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>
  };
  return <svg aria-hidden="true" className={`ui-icon ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

export default function Dashboard() {
  const { user } = useContext(AuthContext);
  const fullEdit = ['frontdesk', 'admin'].includes(user?.role);
  const canEdit = fullEdit || user?.role === 'housekeeping';
  const [selectedDate, setSelectedDate] = useReportDate();
  const { rooms, setRooms, loading, error, refresh } = useDatedRooms(`/room/status/${selectedDate}`, selectedDate);
  const connected = useRoomRealtime({ date: selectedDate, setRooms, refresh, dashboard: true });
  const liveRooms = useRef(null);
  liveRooms.current = { date: selectedDate, fullEdit, canEdit, rooms: new Map(rooms.map(room => [room._id, room])) };
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const checkoutIds = useRef(new Set());
  const editButtons = useRef(new Map());
  const focusAfterEditing = useRef(null);
  const checkoutFocus = useRef(null);
  const boardResults = useRef(null);
  const selectionToolbar = useRef(null);
  const bulkFocus = useRef(null);
  const [checkingOut, setCheckingOut] = useState({});
  const [workflowFilter, setWorkflowFilter] = useState('waiting');
  const [editingRoom, setEditingRoom] = useState(null);
  const [draft, setDraft] = useState({});
  const [originalDraft, setOriginalDraft] = useState({});
  const editingSnapshot = useRef(null);
  const [editError, setEditError] = useState('');
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState(null);
  const [sortBy, setSortBy] = useState('status');
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState(initialFilters);
  const [layout, setLayout] = useState(savedLayout);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkCheckingOut, setBulkCheckingOut] = useState(false);
  const [syncActions, setSyncActions] = useState(new Map());
  const nextSyncId = useRef(0);
  const [retryingSync, setRetryingSync] = useState(false);
  const invalidRange = filters.start && filters.end && filters.end < filters.start;
  const workflowOf = room => frontdeskWorkflow(room, selectedDate);

  const rememberSync = (room, updated, warning, kind, changes = {}, date = selectedDate, retryKey) => {
    if (!warning && !retryKey) return;
    const key = retryKey || `${date}:${room._id}:${++nextSyncId.current}`;
    setSyncActions(previous => {
      const next = new Map(previous);
      if (warning) next.set(key, { key, date, kind, changes, warning, room: { ...room, ...updated, _id: room._id } });
      else next.delete(key);
      return next;
    });
  };
  const canRetrySync = action => {
    const scope = liveRooms.current;
    const current = scope.rooms.get(action.room._id);
    return mounted.current && scope.date === action.date &&
      (action.kind === 'checkout' ? scope.fullEdit && current?.occupancyStatus === 'Vacant' : scope.canEdit) &&
      roomActionMatches(action.room, current, syncSignature);
  };
  const pendingSync = [...syncActions.values()].filter(action => action.date === selectedDate);
  const retryableSync = pendingSync.filter(canRetrySync);

  const retrySync = async () => {
    if (retryingSync || importing || bulkCheckingOut || checkoutIds.current.size || editingRoom || loading) return;
    const targets = retryableSync;
    if (!targets.length) return;
    setRetryingSync(true);
    setNotice(null);
    try {
      const results = await settleRoomActions(targets, async action => {
        if (!canRetrySync(action)) throw new Error('The room changed. Review its current state before retrying sync.');
        const current = liveRooms.current.rooms.get(action.room._id);
        const path = `/room/${current._id}${action.kind === 'checkout' ? '/checkout' : ''}`;
        const response = action.kind === 'checkout'
          ? (Number.isFinite(Date.parse(current.updatedAt)) ? await api.post(path, guardedChanges(current)) : await api.post(path))
          : await api.put(path, guardedChanges(current, action.changes));
        const { data } = response;
        const updated = data.data || data;
        setRooms(previous => previous.map(record => record._id === current._id ? mergeRoomRecord(record, updated) : record));
        rememberSync(current, updated, data.warning, action.kind, action.changes, action.date, action.key);
        return data.warning;
      });
      const completed = results.filter(result => result.status === 'fulfilled' && !result.value).length;
      const issues = results.flatMap((result, index) => {
        const warning = result.status === 'rejected' ? requestError(result.reason, 'Unable to sync. Please try again.') : result.value;
        return warning ? [`Room ${roomNumber(targets[index].room)}: ${warning}`] : [];
      });
      setNotice({ type: issues.length ? 'error' : 'success', message: [`${completed} ${completed === 1 ? 'room' : 'rooms'} synced to housekeeping.`, ...issues].join(' ') });
      if (results.some(result => result.status === 'rejected')) refresh();
    } finally { setRetryingSync(false); }
  };

  const changeLayout = value => {
    setLayout(value);
    try { window.localStorage.setItem(layoutStorageKey, value); }
    catch { /* The layout still works when browser storage is unavailable. */ }
  };

  const filteredRooms = useMemo(() => {
    const filtered = rooms.filter(room => {
      // Keep an open draft available if another staff member changes this room
      // so that it no longer matches the selected filters.
      if (room._id === editingRoom) return true;
      if (!roomNumber(room).toLowerCase().includes(search.trim().toLowerCase())) return false;
      if (workflowFilter !== 'all' && frontdeskWorkflow(room, selectedDate) !== workflowFilter) return false;
      if (filters.status !== 'all' && roomStatus(room) !== filters.status) return false;
      if (filters.occupancy !== 'all' && room.occupancyStatus !== filters.occupancy) return false;
      if (filters.pet !== 'all' && Boolean(room.pet) !== (filters.pet === 'yes')) return false;
      if (filters.dateType !== 'none' && (filters.start || filters.end)) {
        const value = normalizedStayDate(room[filters.dateType], room.reportDate || selectedDate);
        if (!value || (filters.start && value < filters.start) || (filters.end && value > filters.end)) return false;
      }
      return true;
    });
    return filtered.sort((a, b) => {
      const primary = sortBy === 'room' ? roomNumber(a).localeCompare(roomNumber(b), undefined, { numeric: true })
        : sortBy === 'status' ? statusPriority[frontdeskWorkflow(a, selectedDate)] - statusPriority[frontdeskWorkflow(b, selectedDate)]
        : normalizedStayDate(a[sortBy], a.reportDate || selectedDate).localeCompare(normalizedStayDate(b[sortBy], b.reportDate || selectedDate));
      return primary || roomNumber(a).localeCompare(roomNumber(b), undefined, { numeric: true });
    });
  }, [rooms, filters, sortBy, selectedDate, workflowFilter, search, editingRoom]);

  const selectableRooms = filteredRooms.filter(room => room.occupancyStatus === 'Occupied');
  useEffect(() => { setSelectedIds(new Set()); }, [selectedDate, workflowFilter, search, filters]);
  useEffect(() => {
    const eligible = new Set(filteredRooms.filter(room => room.occupancyStatus === 'Occupied').map(room => room._id));
    setSelectedIds(previous => {
      const next = new Set([...previous].filter(id => eligible.has(id)));
      return next.size === previous.size ? previous : next;
    });
  }, [filteredRooms, selectedIds]);

  const toggleSelection = id => setSelectedIds(previous => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  useEffect(() => {
    if (editingRoom || !focusAfterEditing.current) return;
    const button = editButtons.current.get(focusAfterEditing.current);
    focusAfterEditing.current = null;
    button?.focus({ preventScroll: true });
  }, [editingRoom, filteredRooms]);

  useEffect(() => {
    const source = checkoutFocus.current;
    if (!source) return;
    if (source.date !== selectedDate || source.filter !== workflowFilter) {
      checkoutFocus.current = null;
      return;
    }
    if (!source.button.isConnected) {
      checkoutFocus.current = null;
      if (document.activeElement === document.body) boardResults.current?.focus({ preventScroll: true });
    }
  }, [filteredRooms, selectedDate, workflowFilter]);

  useEffect(() => {
    if (bulkCheckingOut || !bulkFocus.current) return;
    const source = bulkFocus.current;
    bulkFocus.current = null;
    if (source.date === selectedDate && source.filter === workflowFilter &&
        (document.activeElement === document.body || (document.activeElement === source.button && source.button.disabled))) {
      selectionToolbar.current?.focus({ preventScroll: true });
    }
  }, [bulkCheckingOut, selectedDate, workflowFilter]);

  const performCheckout = async room => {
    const scope = liveRooms.current;
    const current = scope.rooms.get(room._id);
    if (!mounted.current || !scope.fullEdit || scope.date !== selectedDate || current?.occupancyStatus !== 'Occupied' ||
        !roomActionMatches(room, current, checkoutSignature)) {
      throw new Error('The room changed. Review the guest and stay dates before trying checkout again.');
    }
    checkoutIds.current.add(room._id);
    setCheckingOut(previous => ({ ...previous, [room._id]: true }));
    try {
      const path = `/room/${room._id}/checkout`;
      const { data } = Number.isFinite(Date.parse(current.updatedAt))
        ? await api.post(path, { expectedUpdatedAt: current.updatedAt })
        : await api.post(path);
      const updated = data.data || data;
      setRooms(previous => previous.map(record => record._id === room._id ? mergeRoomRecord(record, updated) : record));
      rememberSync(room, updated, data.warning, 'checkout');
      return { updated, warning: data.warning };
    } finally {
      checkoutIds.current.delete(room._id);
      setCheckingOut(previous => {
        const next = { ...previous };
        delete next[room._id];
        return next;
      });
    }
  };

  const checkOutRoom = async (room, button) => {
    if (!fullEdit || room.occupancyStatus !== 'Occupied' || checkoutIds.current.has(room._id) || bulkCheckingOut) return;
    if (document.activeElement === button) checkoutFocus.current = { button, date: selectedDate, filter: workflowFilter };
    setNotice(null);
    try {
      const { updated, warning } = await performCheckout(room);
      setNotice({ type: warning ? 'error' : 'success', message: warning || `Room ${roomNumber(room)} checked out.${isRoomUnavailable(updated) ? ' It remains unavailable.' : ' Housekeeping can now clean it.'}` });
    } catch (cause) {
      checkoutFocus.current = null;
      setNotice({ type: 'error', message: requestError(cause, `Room ${roomNumber(room)} could not be checked out. Please try again.`) });
      refresh();
    }
  };

  const checkOutSelected = async button => {
    if (!fullEdit || bulkCheckingOut || importing || checkoutIds.current.size || editingRoom) return;
    const targets = selectableRooms.filter(room => selectedIds.has(room._id));
    if (!targets.length) return;
    if (document.activeElement === button) bulkFocus.current = { button, date: selectedDate, filter: workflowFilter };
    setBulkCheckingOut(true);
    setNotice(null);
    try {
      const results = await settleRoomActions(targets, performCheckout);
      const failedIds = new Set();
      const issues = [];
      let completed = 0;
      results.forEach((result, index) => {
        const room = targets[index];
        if (result.status === 'fulfilled') {
          completed += 1;
          if (result.value.warning) issues.push(`Room ${roomNumber(room)}: ${result.value.warning}`);
        } else {
          failedIds.add(room._id);
          issues.push(`Room ${roomNumber(room)}: ${requestError(result.reason, 'Could not check out. Please try again.')}`);
        }
      });
      setSelectedIds(failedIds);
      const success = completed ? `${completed} ${completed === 1 ? 'room' : 'rooms'} checked out.${issues.length ? '' : ' Housekeeping can now clean available rooms.'}` : '';
      const failure = failedIds.size ? `${failedIds.size} could not be checked out.` : '';
      setNotice({ type: issues.length ? 'error' : 'success', message: [success, failure, ...issues].filter(Boolean).join(' ') });
      if (failedIds.size) refresh();
    } finally { setBulkCheckingOut(false); }
  };

  const startEditing = room => {
    setSelectionMode(false);
    setSelectedIds(new Set());
    setEditingRoom(room._id);
    setEditError('');
    const values = editableValues(room, fullEdit, selectedDate);
    editingSnapshot.current = room;
    setDraft(values);
    setOriginalDraft(values);
  };
  const changeDraft = (field, value) => setDraft(previous => ({ ...previous, [field]: value }));
  const cancelEditing = () => {
    focusAfterEditing.current = editingRoom;
    setEditingRoom(null);
    setDraft({});
    setEditError('');
    editingSnapshot.current = null;
  };

  const saveRoom = async event => {
    event.preventDefault();
    if (saving) return;
    const checkIn = normalizedStayDate(draft.checkIn, selectedDate);
    const checkOut = normalizedStayDate(draft.checkOut, selectedDate);
    if (checkIn && checkOut && checkOut < checkIn) {
      setEditError('Check-out must be on or after check-in.');
      return;
    }
    setSaving(true);
    setEditError('');
    try {
      const values = fullEdit ? { ...draft, checkIn: checkIn || draft.checkIn, checkOut: checkOut || draft.checkOut } : draft;
      const updates = Object.fromEntries(Object.entries(values).filter(([field, value]) => value !== originalDraft[field]));
      if (Object.keys(updates).length === 0) {
        cancelEditing();
        setNotice({ type: 'success', message: 'No changes to save.' });
        return;
      }
      const current = liveRooms.current.rooms.get(editingRoom);
      if (!current) throw new Error('The room changed. Refresh the board before saving.');
      const latestValues = editableValues(current, fullEdit, selectedDate);
      const fieldConflict = Object.keys(updates).some(field => latestValues[field] !== originalDraft[field]);
      const stayConflict = Object.keys(updates).some(field => checkoutFields.includes(field)) &&
        checkoutSignature(editingSnapshot.current) !== checkoutSignature(current);
      if (fieldConflict || stayConflict) {
        throw new Error('Another staff member changed this room while you were editing. Your draft is kept. Cancel and reopen the room to review the latest details before saving.');
      }
      const { data } = await api.put(`/room/${editingRoom}`, guardedChanges(current, updates));
      const updated = data.data || data;
      setRooms(previous => previous.map(room => room._id === editingRoom ? mergeRoomRecord(room, updated) : room));
      rememberSync(current, updated, data.warning, 'edit', updates);
      cancelEditing();
      setNotice({ type: data.warning ? 'error' : 'success', message: data.warning || `Room ${roomNumber(updated)} saved.` });
    } catch (cause) {
      setEditError(requestError(cause, 'Unable to save this room. Please try again.'));
    } finally { setSaving(false); }
  };

  const importRooms = async () => {
    if (importing || !rooms.length) return;
    setImporting(true);
    setNotice(null);
    try {
      const { data } = await api.post('/room/import-to-housekeeping', { date: selectedDate });
      const count = data.importedCount ?? data.imported ?? rooms.length;
      setNotice({ type: 'success', message: `${count} rooms are ready for housekeeping on ${selectedDate}.${data.preservedCount ? ` Existing progress for ${data.preservedCount} rooms was kept.` : ''}`, imported: true });
    } catch (cause) {
      setNotice({ type: 'error', message: requestError(cause, 'Unable to import rooms. Please try again.') });
    } finally { setImporting(false); }
  };

  const changeFilter = (field, value) => setFilters(previous => ({ ...previous, [field]: value }));
  const busy = importing || bulkCheckingOut || retryingSync || Object.keys(checkingOut).length > 0;

  return (
    <div className="room-page frontdesk-page">
      <div className="room-page-inner">
        <div className="page-heading">
          <div><h1>Front desk</h1><p>Check out guests and follow cleaning progress in real time.</p></div>
          <div className="heading-actions"><LiveConnection connected={connected} error={error} />{fullEdit ? <Link to={`/upload-report?date=${selectedDate}`} className="primary-action"><DeskIcon name="upload" />Upload morning PDF</Link> : null}</div>
        </div>
        {notice ? <div role={notice.type === 'error' ? 'alert' : 'status'} className={`board-notice notice-${notice.type}`}><span>{notice.message}</span>{notice.imported ? <Link to={`/housekeeping?date=${selectedDate}`}>Open housekeeping</Link> : null}<button type="button" aria-label="Dismiss notification" onClick={() => setNotice(null)} className="notice-dismiss">×</button></div> : null}
        {pendingSync.length ? <div role="region" aria-label="Housekeeping synchronization" className="board-notice notice-error">
          <span>Changes saved. Housekeeping still needs to sync for {[...new Set(pendingSync.map(action => `room ${roomNumber(action.room)}`))].join(', ')}.
            {pendingSync.some(action => !canRetrySync(action)) ? ' A room changed. Review its current state before retrying sync.' : ''}
          </span>
          <button type="button" className="text-action" aria-label="Retry housekeeping sync" onClick={retrySync} disabled={busy || loading || Boolean(editingRoom) || !retryableSync.length}>{retryingSync ? 'Syncing…' : 'Retry sync'}</button>
          <button type="button" aria-label="Dismiss sync warning" className="notice-dismiss" disabled={retryingSync} onClick={() => setSyncActions(previous => new Map([...previous].filter(([, action]) => action.date !== selectedDate)))}>×</button>
        </div> : null}
        <WorkflowSummary rooms={rooms} workflowOf={workflowOf} statuses={deskStatuses} />
        <div className="board-toolbar">
          <div className="board-title"><h2>Room board</h2><span>{rooms.length} rooms · {reportDateFormat.format(new Date(`${selectedDate}T12:00:00`))}</span></div>
          <div className="date-tools"><DateSelector date={selectedDate} onChange={date => { setSelectedDate(date); setNotice(null); }} disabled={Boolean(editingRoom) || busy} /><button type="button" onClick={refresh} disabled={loading || busy || Boolean(editingRoom)} className="refresh-action primary-action"><DeskIcon name="refresh" />{loading && rooms.length ? 'Refreshing…' : 'Refresh rooms'}</button></div>
        </div>
        <div className="board-control-row">
          <label className="room-search" htmlFor="desk-room-search"><span className="sr-only">Find a room</span><DeskIcon name="search" /><input id="desk-room-search" type="search" placeholder="Find a room" value={search} disabled={Boolean(editingRoom) || busy} onChange={event => setSearch(event.target.value)} /></label>
          <div role="group" aria-label="Room layout" className="room-layout-switch">
            <button type="button" aria-pressed={layout === 'table'} onClick={() => changeLayout('table')}><DeskIcon name="table" />Table</button>
            <button type="button" aria-pressed={layout === 'boxes'} onClick={() => changeLayout('boxes')}><DeskIcon name="boxes" />Boxes</button>
          </div>
          {fullEdit ? <button type="button" className="secondary-action room-select-toggle" aria-pressed={selectionMode} disabled={Boolean(editingRoom) || busy || !rooms.length} onClick={() => { setSelectionMode(previous => !previous); setSelectedIds(new Set()); }}>{selectionMode ? 'Finish selecting' : 'Select rooms'}</button> : null}
          <details className="board-options">
            <summary><DeskIcon name="filters" /><span>More filters and report tools</span></summary>
            <fieldset disabled={Boolean(editingRoom) || busy} className="board-options-content">
              <div className="filter-heading"><h2>Filters &amp; Sort</h2><button type="button" onClick={() => { setFilters(initialFilters); setSortBy('status'); setWorkflowFilter('waiting'); setSearch(''); }} className="text-action">Reset filters</button></div>
              <div className="advanced-filter-grid">
                <Field label="Sort by"><select value={sortBy} onChange={event => setSortBy(event.target.value)} className={inputClass}><option value="status">Room status (checkout first)</option><option value="room">Room Number</option><option value="checkIn">Check-in Date</option><option value="checkOut">Check-out Date</option></select></Field>
                <Field label="Housekeeping Status"><select value={filters.status} onChange={event => changeFilter('status', event.target.value)} className={inputClass}><option value="all">All</option>{HOUSEKEEPING_STATUSES.map(status => <option key={status}>{status}</option>)}</select></Field>
                <Field label="Occupancy"><select value={filters.occupancy} onChange={event => changeFilter('occupancy', event.target.value)} className={inputClass}><option value="all">All</option><option>Occupied</option><option>Vacant</option></select></Field>
                <Field label="Pet Status"><select value={filters.pet} onChange={event => changeFilter('pet', event.target.value)} className={inputClass}><option value="all">All Rooms</option><option value="yes">With Pets</option><option value="no">No Pets</option></select></Field>
                <Field label="Date Filter Type"><select value={filters.dateType} onChange={event => setFilters(previous => ({ ...previous, dateType: event.target.value, start: '', end: '' }))} className={inputClass}><option value="none">No Date Filter</option><option value="checkIn">Check-in Date</option><option value="checkOut">Check-out Date</option></select></Field>
                {filters.dateType !== 'none' ? <><Field label="From"><input type="date" value={filters.start} max={filters.end || undefined} onChange={event => changeFilter('start', event.target.value)} className={inputClass} /></Field><Field label="To"><input type="date" value={filters.end} min={filters.start || undefined} onChange={event => changeFilter('end', event.target.value)} className={inputClass} /></Field></> : null}
              </div>
              {invalidRange ? <p role="alert" className="editor-error">The end date must be on or after the start date.</p> : null}
              {fullEdit ? <div className="report-sync"><p>For older reports or an interrupted upload, sync the rooms to housekeeping again. Existing cleaning progress is kept.</p><button type="button" onClick={importRooms} disabled={loading || busy || Boolean(editingRoom) || !rooms.length} className="secondary-action">{importing ? 'Syncing…' : 'Sync housekeeping board'}</button></div> : null}
            </fieldset>
          </details>
        </div>
        <WorkflowFilters rooms={rooms} value={workflowFilter} onChange={setWorkflowFilter} disabled={Boolean(editingRoom) || busy} workflowOf={workflowOf} statuses={deskStatuses} />
        {selectionMode ? <div ref={selectionToolbar} tabIndex={-1} className="room-selection-toolbar" role="group" aria-label="Selected room actions" aria-busy={bulkCheckingOut}>
          <span className="room-selection-count" aria-live="polite">{selectedIds.size} {selectedIds.size === 1 ? 'room' : 'rooms'} selected</span>
          <div className="room-selection-actions">
            <button type="button" className="text-action" disabled={busy || !selectableRooms.length} onClick={() => setSelectedIds(new Set(selectableRooms.map(room => room._id)))}>Select all visible rooms</button>
            <button type="button" className="text-action" disabled={busy || !selectedIds.size} onClick={() => setSelectedIds(new Set())}>Clear selection</button>
            <button type="button" className="checkout-action" disabled={busy || !selectedIds.size} onClick={event => checkOutSelected(event.currentTarget)}>{bulkCheckingOut ? 'Checking out…' : 'Check out selected'}</button>
          </div>
          <p>Only occupied rooms can be selected for checkout.</p>
        </div> : null}
        {editingRoom ? <div className="edit-reminder"><p>Finish editing your room before changing the date or filters.</p><button type="button" disabled={saving} onClick={cancelEditing} className="text-action">Cancel edit</button></div> : null}
        {loading ? <div role="status" className="board-loading"><p>{rooms.length ? 'Refreshing room report…' : 'Loading room report…'}</p></div> : null}
        {error ? <div role="alert" className="board-notice notice-error"><p>{error}</p><button type="button" onClick={refresh} className="text-action">Try again</button></div> : null}
        {(!loading || rooms.length > 0) && (!error || rooms.length > 0) ? <div ref={boardResults} role="region" aria-label="Room board results" tabIndex={-1}>
          <p className={filteredRooms.length === rooms.length ? 'sr-only' : 'room-result-count'} aria-live="polite">Showing {filteredRooms.length} of {rooms.length} rooms</p>
          {rooms.length === 0 ? <div className="empty-state"><h2>No room report for {selectedDate}</h2><p>Choose another date{fullEdit ? ' or upload a report to get started.' : ' or ask the front desk to upload a report.'}</p>{fullEdit ? <Link to={`/upload-report?date=${selectedDate}`} className="text-action">Upload a report</Link> : null}</div>
            : filteredRooms.length === 0 ? <div className="empty-state"><h2>{workflowFilter === 'waiting' && !search && filters === initialFilters ? 'No guests waiting for checkout' : 'No rooms match these filters'}</h2><button type="button" onClick={() => { setFilters(initialFilters); setWorkflowFilter('all'); setSearch(''); }} className="text-action">Clear filters</button></div>
            : <div className={`desk-board${layout === 'boxes' ? ' is-box-layout' : ''}`}>
              <div className="desk-columns" aria-hidden="true"><span>Room</span><span>Room status</span><span>Guest / stay</span><span>Attendant</span><span>Notes</span><span>Actions</span></div>
              {filteredRooms.map(room => <article key={room._id} aria-label={`Room ${roomNumber(room)}, ${WORKFLOW_LABELS[workflowOf(room)]}`} className={`room-card desk-room workflow-${workflowOf(room)} ${room.pet ? 'pet-room' : ''}${editingRoom === room._id ? ' is-editing' : ''}${selectedIds.has(room._id) ? ' is-selected' : ''}`}>
                <div className="desk-row">
                  <div className="desk-number"><h3>{roomNumber(room)}</h3>{room.type ? <small>{room.type}</small> : null}{selectionMode ? <label className="room-select-control"><input type="checkbox" aria-label={`Select room ${roomNumber(room)}`} checked={selectedIds.has(room._id)} disabled={busy || room.occupancyStatus !== 'Occupied'} onChange={() => toggleSelection(room._id)} /><span className="sr-only">Select room {roomNumber(room)}</span></label> : null}</div>
                  <div className="desk-status"><WorkflowStatus workflow={workflowOf(room)} /><span>{occupancyLabel(room, selectedDate)}</span></div>
                  {layout === 'boxes' ? <details className="desk-box-details"><summary>Room details{room.pet ? ' · Pet' : ''}{room.notes || room.reason || room.description ? ' · Notes' : ''}</summary><div><RoomDetails room={room} date={selectedDate} /></div></details> : <RoomDetails room={room} date={selectedDate} />}
                  <div className="desk-actions">
                    {fullEdit && room.occupancyStatus === 'Occupied' && editingRoom !== room._id ? <button type="button" onClick={event => checkOutRoom(room, event.currentTarget)} disabled={Boolean(editingRoom) || busy || selectionMode} aria-label={`Check out room ${roomNumber(room)}`} className="checkout-action">{checkingOut[room._id] ? 'Checking out…' : 'Check out'}</button> : null}
                    {canEdit && editingRoom !== room._id ? <button ref={button => { if (button) editButtons.current.set(room._id, button); else editButtons.current.delete(room._id); }} type="button" aria-label={`Edit room ${roomNumber(room)}`} onClick={() => startEditing(room)} disabled={Boolean(editingRoom) || busy} className="desk-edit">Edit</button> : null}
                  </div>
                </div>
                {editingRoom === room._id ? <div className="desk-detail"><RoomEditor room={room} draft={draft} fullEdit={fullEdit} saving={saving} error={editError} onChange={changeDraft} onCancel={cancelEditing} onSave={saveRoom} /></div> : null}
              </article>)}
              <WorkflowLegend statuses={deskStatuses} />
            </div>}
        </div> : null}
      </div>
    </div>
  );
}
