import React, { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';
import { AuthContext } from '../context/authContext';
import DateSelector, { useReportDate } from './DateSelector';
import useDatedRooms from '../hooks/useDatedRooms';
import useRoomRealtime from '../hooks/useRoomRealtime';
import { isRoomUnavailable, localDate, mergeRoomRecord, normalizedStayDate, requestError, roomNumber, roomStatus, sortRooms } from '../utils/roomData';
import { housekeepingTask, housekeepingTaskCounts, isStayoverRoom } from '../utils/housekeepingTasks';
import { settleRoomActions } from '../utils/roomActions';
import { LiveConnection } from './RoomWorkflow';

// Every room is one colored box. Solid boxes are housekeeping's work; light
// boxes are waiting for the front desk, finished, or blocked.
const TABS = [
  { id: 'ready', label: 'Ready to clean', title: 'Ready to clean', hint: 'These rooms are vacant and ready for cleaning. Tap a red room when it’s clean.', colorKey: [['ready', 'Dirty']], empty: 'No rooms ready to clean', emptyHint: 'New checkouts appear here as soon as front desk confirms they have left.' },
  { id: 'services', label: 'Services', title: 'Stayover services', hint: 'The guest is staying. Tap a blue room when service is done. Green rooms are already serviced.', colorKey: [['stayover', 'Service not done'], ['done', 'Service done']], empty: 'No stayover services', emptyHint: 'Rooms with continuing guests will appear here.' },
  { id: 'waiting', label: 'Waiting for checkout', title: 'Waiting for checkout', hint: 'The guest is still in the room. Wait for front desk to confirm checkout.', colorKey: [['waiting', 'Not checked out yet']], empty: 'No rooms waiting for checkout', emptyHint: 'Guests due to leave will appear here until checkout is confirmed.' },
  { id: 'done', label: 'Done', title: 'Done', hint: 'Clean rooms and completed stayover services. Use Revert to put a room back on the work list.', colorKey: [['done', 'Clean or serviced']], empty: 'No completed rooms yet', emptyHint: 'Rooms appear here after cleaning or stayover service is complete.' },
  { id: 'unavailable', label: 'Unavailable', title: 'Unavailable', hint: 'Do not clean these rooms until front desk or maintenance releases them.', colorKey: [['unavailable', 'Do not clean']], empty: 'No unavailable rooms', emptyHint: 'All rooms are available for their normal housekeeping workflow.' }
];

function Icon({ name }) {
  const paths = {
    check: <path d="m5 12 4 4L19 6" />,
    undo: <><path d="M9 4 4 9l5 5M4 9h9a6 6 0 0 1 0 12" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
    note: <><path d="M6 3h9l4 4v14H6Z" /><path d="M14 3v5h5M9 13h6M9 17h4" /></>,
    pet: <g fill="currentColor" stroke="none"><circle cx="5.5" cy="10" r="2.2" /><circle cx="9.2" cy="5.2" r="2.2" /><circle cx="14.8" cy="5.2" r="2.2" /><circle cx="18.5" cy="10" r="2.2" /><path d="M12 11.5c-3.2 0-6.2 3.6-6.2 6.4 0 1.8 1.4 3 3.1 3 1.3 0 2.1-.7 3.1-.7s1.8.7 3.1.7c1.7 0 3.1-1.2 3.1-3 0-2.8-3-6.4-6.2-6.4Z" /></g>
  };
  return <svg aria-hidden="true" className="hk-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

function roomNotes(room) {
  return [...new Set([room.notes, room.reason, room.description, ...(room.issues || [])].filter(Boolean))];
}

function roomBox(room, date) {
  const task = housekeepingTask(room, date);
  if (isStayoverRoom(room, date)) {
    const done = task === 'done';
    return { task, stayover: true, tone: done ? 'done' : 'stayover', label: done ? 'Done' : 'Not done', status: done ? 'Service done' : 'Service not done' };
  }
  let label = { ready: 'Dirty', done: 'Clean' }[task];
  if (task === 'unavailable') label = isRoomUnavailable(room) ? roomStatus(room) : 'Unavailable';
  // Only call a waiting room a checkout when the report says the guest is leaving.
  if (task === 'waiting') label = (normalizedStayDate(room.checkOut, date) || /\b(?:due|checked)[\s_-]*out\b/i.test(room.guestStatus || '')) ? 'Checkout' : 'Occupied';
  return { task, stayover: false, tone: task, label, status: label };
}

function roomVersion(room) {
  const time = room?.updatedAt ? new Date(room.updatedAt).getTime() : NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : '';
}

function operationalSignature(room, date) {
  if (!room) return '';
  return JSON.stringify([
    housekeepingTask(room, date), isStayoverRoom(room, date), room.occupancyStatus, room.housekeepingStatus,
    room.guestStatus || '', room.checkIn || '', room.checkOut || '', room.checkedOutAt || '',
    room.stayoverServicedAt || '', room.orderStatus || '', room.reportDate || '', roomVersion(room)
  ]);
}

function guardedChanges(room, changes) {
  const expectedUpdatedAt = roomVersion(room);
  return expectedUpdatedAt ? { ...changes, expectedUpdatedAt } : changes;
}

function syncAction(room, updated, changes, date, warning) {
  const saved = mergeRoomRecord(room, updated);
  return { roomId: room._id, number: roomNumber(room), changes, date, warning, version: roomVersion(saved), signature: operationalSignature(saved, date) };
}

function canRetrySync(room, action) {
  if (!room || operationalSignature(room, action.date) !== action.signature) return false;
  return Object.entries(action.changes).every(([field, value]) => field === 'stayoverServicedAt'
    ? (value === null ? room[field] === null : new Date(room[field]).getTime() === new Date(value).getTime())
    : room[field] === value);
}

function RoomBox({ room, box, fresh, canUpdate, saving, onComplete, selecting, selected, selectionDisabled, onSelect }) {
  const number = roomNumber(room);
  const hasNotes = roomNotes(room).length > 0;
  const icon = { done: 'check', waiting: 'clock', unavailable: 'lock' }[box.tone];
  const className = `hk-box hk-tone-${box.tone}${fresh ? ' is-new' : ''}`;
  const content = <>
    {fresh ? <span className="hk-box-new">New</span> : null}
    {room.pet || hasNotes ? <span className="hk-box-flags">{room.pet ? <Icon name="pet" /> : null}{hasNotes ? <Icon name="note" /> : null}</span> : null}
    <span className="hk-box-number">{number}</span>
    <span className="hk-box-label">{icon ? <Icon name={icon} /> : null}{saving ? 'Saving…' : box.label}</span>
  </>;
  const checkboxId = `hk-select-${room._id}`;
  return <li className={`hk-box-entry${selected ? ' is-selected' : ''}`} aria-label={`Room ${number}, ${box.status}`} aria-busy={saving}>
    {selecting
      ? <label className={className} htmlFor={checkboxId}>{content}</label>
      : canUpdate && ['ready', 'stayover'].includes(box.task)
      ? <button type="button" className={className} disabled={saving} onClick={event => onComplete(room, false, event.currentTarget)}
        aria-label={saving ? `Saving room ${number}` : box.stayover ? `Mark room ${number} service done` : `Mark room ${number} clean`}>{content}</button>
      : <div className={className}>{content}</div>}
    {selecting ? <label className="hk-box-select" htmlFor={checkboxId}><input id={checkboxId} type="checkbox" aria-label={`Select room ${number}`} checked={selected} disabled={selectionDisabled || saving} onChange={() => onSelect(room)} /><span>{selected ? 'Selected' : 'Select'}</span></label> : null}
    {!selecting && canUpdate && box.task === 'done' ? <button type="button" className="hk-box-revert" disabled={saving} onClick={event => onComplete(room, true, event.currentTarget)} aria-label={`Revert room ${number} ${box.stayover ? 'service' : 'cleaning'}`}><Icon name="undo" />{saving ? 'Saving…' : 'Revert'}</button> : null}
  </li>;
}

function RoomNotes({ rooms }) {
  const noted = rooms.filter(room => room.pet || roomNotes(room).length);
  if (!noted.length) return null;
  return <div className="hk-notes"><h3>Notes</h3><ul>{noted.map(room => <li key={room._id} aria-label={`Notes for room ${roomNumber(room)}`}>
    <strong>{roomNumber(room)}</strong>
    <span>{room.pet ? <span className="hk-pet"><Icon name="pet" />Pet in room</span> : null}{roomNotes(room).map(note => <span key={note}>{note}</span>)}</span>
  </li>)}</ul></div>;
}

function RoomSection({ id, title, hint, colorKey, entries, fresh, canUpdate, pending, onComplete, selecting, selectedRooms, selectionDisabled, onSelect, date }) {
  if (!entries.length) return null;
  const counts = {};
  entries.forEach(({ box }) => { counts[box.tone] = (counts[box.tone] || 0) + 1; });
  return <section className="hk-section" aria-labelledby={id}>
    <div className="hk-section-head"><h2 id={id}>{title}</h2><p>{hint}</p></div>
    <ul className="hk-key" aria-label={`${title} colors`}>{colorKey.map(([tone, label]) => <li key={tone}><span aria-hidden="true" className={`hk-swatch hk-tone-${tone}`} />{label} <b>{counts[tone] || 0}</b></li>)}</ul>
    <ul className="hk-boxes">{entries.map(({ room, box }) => <RoomBox key={room._id} room={room} box={box} fresh={box.task === 'ready' && fresh.has(room._id)} canUpdate={canUpdate} saving={Boolean(pending[room._id])} onComplete={onComplete} selecting={selecting} selected={selectedRooms.get(room._id) === operationalSignature(room, date)} selectionDisabled={selectionDisabled} onSelect={onSelect} />)}</ul>
    <RoomNotes rooms={entries.map(({ room }) => room)} />
  </section>;
}

export default function HouseKeeping() {
  const { user } = useContext(AuthContext);
  const canUpdate = ['housekeeping', 'admin'].includes(user?.role);
  const canImport = ['frontdesk', 'admin'].includes(user?.role);
  const [selectedDate, setSelectedDate] = useReportDate();
  const { rooms, setRooms, loading, error, refresh } = useDatedRooms('/housekeeper', selectedDate);
  const connected = useRoomRealtime({ date: selectedDate, setRooms, refresh });
  const pendingIds = useRef(new Set());
  const seenTasks = useRef({ date: '', tasks: new Map() });
  const [pending, setPending] = useState({});
  const [fresh, setFresh] = useState(() => new Set());
  const [updateError, setUpdateError] = useState('');
  const [notice, setNotice] = useState(null);
  const [syncActions, setSyncActions] = useState(() => new Map());
  const liveRooms = useRef(rooms);
  liveRooms.current = rooms;
  const [activeTab, setActiveTab] = useState('ready');
  const tabButtons = useRef(new Map());
  const panelRef = useRef(null);
  const focusAfterSave = useRef(null);
  const currentView = useRef(null);
  currentView.current = { tab: activeTab, date: selectedDate };
  const [search, setSearch] = useState('');
  const [attendantFilter, setAttendantFilter] = useState('all');
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedRooms, setSelectedRooms] = useState(() => new Map());
  const [bulkBusy, setBulkBusy] = useState(false);
  const bulkLock = useRef(false);
  const selectionToolbar = useRef(null);
  const bulkFocus = useRef(null);

  // A front desk checkout arrives live. Flag rooms that just went from waiting
  // to dirty so housekeeping notices them; a newly loaded date flags nothing.
  useEffect(() => {
    const tasks = new Map(rooms.map(room => [room._id, housekeepingTask(room, selectedDate)]));
    const previous = seenTasks.current;
    seenTasks.current = { date: selectedDate, tasks };
    if (previous.date !== selectedDate) {
      setFresh(current => current.size ? new Set() : current);
      return;
    }
    const checkedOut = rooms.filter(room => previous.tasks.get(room._id) === 'waiting' && tasks.get(room._id) === 'ready').map(room => room._id);
    if (checkedOut.length) setFresh(current => new Set([...current, ...checkedOut]));
  }, [rooms, selectedDate]);

  useEffect(() => {
    const savedFocus = focusAfterSave.current;
    if (!savedFocus) return;
    focusAfterSave.current = null;
    if (savedFocus.tab === activeTab && savedFocus.date === selectedDate && !savedFocus.button.isConnected) {
      panelRef.current?.focus({ preventScroll: true });
    }
  }, [rooms, activeTab, selectedDate]);

  useEffect(() => {
    const savedFocus = bulkFocus.current;
    if (bulkBusy || !savedFocus) return;
    bulkFocus.current = null;
    const focused = document.activeElement;
    if (savedFocus.tab === activeTab && savedFocus.date === selectedDate &&
      (focused === document.body || (focused === savedFocus.button && savedFocus.button.disabled))) {
      selectionToolbar.current?.focus({ preventScroll: true });
    }
  }, [bulkBusy, activeTab, selectedDate]);

  const attendants = useMemo(() => [...new Set(rooms.map(room => room.assignedAttendant).filter(Boolean))].sort(), [rooms]);
  const entries = useMemo(() => sortRooms(rooms).filter(room => {
    if (!roomNumber(room).toLowerCase().includes(search.trim().toLowerCase())) return false;
    if (attendantFilter === 'unassigned' && room.assignedAttendant) return false;
    if (attendantFilter !== 'all' && attendantFilter !== 'unassigned' && room.assignedAttendant !== attendantFilter) return false;
    return true;
  }).map(room => ({ room, box: roomBox(room, selectedDate) })), [rooms, selectedDate, search, attendantFilter]);
  const busy = bulkBusy || Object.keys(pending).length > 0;
  const counts = housekeepingTaskCounts(rooms, selectedDate);
  const tabCounts = { ...counts, services: rooms.filter(room => isStayoverRoom(room, selectedDate)).length };
  const selectedTab = TABS.find(tab => tab.id === activeTab);
  const visibleEntries = useMemo(() => entries.filter(({ box }) => activeTab === 'services' ? box.stayover : box.task === activeTab), [entries, activeTab]);
  const canSelect = canUpdate && ['ready', 'services', 'done'].includes(activeTab);
  const selectableEntries = useMemo(() => canSelect ? visibleEntries.filter(({ box }) => ['ready', 'stayover', 'done'].includes(box.task)) : [], [canSelect, visibleEntries]);
  const selectedEntries = selectableEntries.filter(({ room }) => selectedRooms.get(room._id) === operationalSignature(room, selectedDate));
  const selectedToComplete = selectedEntries.filter(({ box }) => ['ready', 'stayover'].includes(box.task));
  const selectedToRevert = selectedEntries.filter(({ box }) => box.task === 'done');

  useEffect(() => {
    setSelectedRooms(current => current.size ? new Map() : current);
  }, [selectedDate, activeTab, search, attendantFilter]);

  useEffect(() => {
    if (!canSelect) setSelectionMode(false);
    // A live checkout, maintenance block, or completion can change what an
    // earlier selection means. Never carry that selection into a new action.
    const eligible = new Map(selectableEntries.map(({ room }) => [room._id, operationalSignature(room, selectedDate)]));
    setSelectedRooms(current => {
      const next = new Map([...current].filter(([id, task]) => eligible.get(id) === task));
      return next.size === current.size ? current : next;
    });
  }, [canSelect, selectableEntries, selectedDate]);
  const today = localDate();
  const displayDate = new Date(`${selectedDate}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  const freshRooms = sortRooms(rooms.filter(room => fresh.has(room._id) && housekeepingTask(room, selectedDate) === 'ready')).map(roomNumber);
  const undoRoom = notice?.roomId ? rooms.find(room => room._id === notice.roomId && housekeepingTask(room, selectedDate) === 'done' && isStayoverRoom(room, selectedDate) === notice.stayover) : null;
  const filtered = Boolean(search.trim()) || attendantFilter !== 'all';
  const activeSyncActions = [...syncActions.values()].filter(action => action.date === selectedDate);
  const retryableSyncActions = activeSyncActions.filter(action => canRetrySync(rooms.find(room => room._id === action.roomId), action));

  const recordSyncOutcome = (room, updated, changes, warning) => {
    const key = `${selectedDate}:${room._id}`;
    setSyncActions(current => {
      const next = new Map(current);
      if (warning) next.set(key, syncAction(room, updated, changes, selectedDate, warning));
      else next.delete(key);
      return next;
    });
  };

  const updateStatus = async (room, undo = false, actionButton) => {
    const task = housekeepingTask(room, selectedDate);
    if (!canUpdate || bulkLock.current || (undo ? task !== 'done' : !['ready', 'stayover'].includes(task)) || pendingIds.current.has(room._id)) return;
    const hadFocus = actionButton && document.activeElement === actionButton;
    const stayover = isStayoverRoom(room, selectedDate);
    const changes = stayover ? { stayoverServicedAt: undo ? null : new Date().toISOString() } : { housekeepingStatus: undo ? 'Dirty' : 'Clean' };
    pendingIds.current.add(room._id);
    setPending(previous => ({ ...previous, [room._id]: true }));
    setUpdateError('');
    setNotice(null);
    try {
      const { data } = await api.put(`/housekeeper/${room._id}`, guardedChanges(room, changes));
      const updated = data.data || data;
      if (hadFocus && (document.activeElement === actionButton || document.activeElement === document.body) && currentView.current.tab === activeTab && currentView.current.date === selectedDate) {
        focusAfterSave.current = { button: actionButton, tab: activeTab, date: selectedDate };
      }
      setRooms(previous => previous.map(record => record._id === room._id ? mergeRoomRecord(record, updated) : record));
      recordSyncOutcome(room, updated, changes, data.warning);
      setFresh(current => {
        if (!current.has(room._id)) return current;
        const next = new Set(current);
        next.delete(room._id);
        return next;
      });
      const message = undo
        ? `Room ${roomNumber(room)} ${stayover ? 'service is marked not done.' : 'is marked dirty again.'}`
        : `Room ${roomNumber(room)} ${stayover ? 'service is done.' : 'is clean.'}${data.warning ? '' : ' Front desk can see it now.'}`;
      setNotice({ message: `${message}${data.warning ? ' Saved here; front desk sync needs retry.' : ''}`, roomId: undo ? null : room._id, stayover });
    } catch (cause) {
      setUpdateError(requestError(cause, `Room ${roomNumber(room)} was not saved. Please try again.`));
      refresh();
    } finally {
      pendingIds.current.delete(room._id);
      setPending(previous => { const next = { ...previous }; delete next[room._id]; return next; });
    }
  };

  const toggleRoomSelection = room => {
    if (bulkLock.current || pendingIds.current.has(room._id)) return;
    const entry = selectableEntries.find(candidate => candidate.room._id === room._id);
    if (!entry) return;
    setSelectedRooms(current => {
      const next = new Map(current);
      if (next.has(room._id)) next.delete(room._id);
      else next.set(room._id, operationalSignature(entry.room, selectedDate));
      return next;
    });
  };

  const updateSelected = async (undo = false, actionButton) => {
    const targets = (undo ? selectedToRevert : selectedToComplete).filter(({ room }) => !pendingIds.current.has(room._id));
    if (!canUpdate || bulkLock.current || loading || !targets.length) return;
    bulkFocus.current = actionButton && document.activeElement === actionButton
      ? { button: actionButton, tab: activeTab, date: selectedDate } : null;
    bulkLock.current = true;
    setBulkBusy(true);
    targets.forEach(({ room }) => pendingIds.current.add(room._id));
    setPending(current => ({ ...current, ...Object.fromEntries(targets.map(({ room }) => [room._id, true])) }));
    setNotice(null);
    setUpdateError('');
    try {
      const results = await settleRoomActions(targets, async ({ room, box }) => {
        const current = liveRooms.current.find(record => record._id === room._id);
        if (currentView.current.date !== selectedDate || operationalSignature(current, selectedDate) !== operationalSignature(room, selectedDate)) {
          throw new Error('The room changed. Review its current state before trying again.');
        }
        const changes = box.stayover ? { stayoverServicedAt: undo ? null : new Date().toISOString() } : { housekeepingStatus: undo ? 'Dirty' : 'Clean' };
        const { data } = await api.put(`/housekeeper/${room._id}`, guardedChanges(current, changes));
        return { room, changes, updated: data.data || data, warning: data.warning };
      });
      const saved = new Map();
      const failures = [];
      const warnings = [];
      results.forEach((result, index) => {
        const room = targets[index].room;
        if (result.status === 'fulfilled') {
          saved.set(room._id, result.value.updated);
          recordSyncOutcome(room, result.value.updated, result.value.changes, result.value.warning);
          if (result.value.warning) warnings.push(`Room ${roomNumber(room)}: ${result.value.warning}`);
        } else {
          failures.push(`Room ${roomNumber(room)}: ${requestError(result.reason, 'Not saved. Please try again.')}`);
        }
      });
      if (saved.size) {
        setRooms(current => current.map(room => saved.has(room._id) ? mergeRoomRecord(room, saved.get(room._id)) : room));
        setFresh(current => new Set([...current].filter(id => !saved.has(id))));
        setSelectedRooms(current => new Map([...current].filter(([id]) => !saved.has(id))));
      }
      const savedMessage = saved.size
        ? undo ? `${saved.size} ${saved.size === 1 ? 'room' : 'rooms'} reverted.`
          : activeTab === 'services' ? `${saved.size} ${saved.size === 1 ? 'stayover service' : 'stayover services'} marked done.`
            : `${saved.size} ${saved.size === 1 ? 'room' : 'rooms'} marked clean.`
        : 'No rooms were saved.';
      const failedMessage = failures.length ? ` ${failures.length} ${failures.length === 1 ? 'room could' : 'rooms could'} not be saved. Eligible rooms remain selected for retry.` : '';
      const syncMessage = warnings.length ? ` ${warnings.length} ${warnings.length === 1 ? 'room' : 'rooms'} saved; front desk sync needs retry.` : '';
      setNotice({ message: `${savedMessage}${failedMessage}${syncMessage}`, roomId: null });
      if (failures.length) setUpdateError(failures.join(' '));
      if (failures.length) refresh();
    } finally {
      targets.forEach(({ room }) => pendingIds.current.delete(room._id));
      setPending(current => {
        const next = { ...current };
        targets.forEach(({ room }) => delete next[room._id]);
        return next;
      });
      bulkLock.current = false;
      setBulkBusy(false);
    }
  };

  const retrySync = async actionButton => {
    const targets = retryableSyncActions.filter(action => !pendingIds.current.has(action.roomId));
    if (!canUpdate || busy || loading || bulkLock.current || !targets.length) return;
    const hadFocus = actionButton && document.activeElement === actionButton;
    bulkLock.current = true;
    setBulkBusy(true);
    targets.forEach(action => pendingIds.current.add(action.roomId));
    setPending(current => ({ ...current, ...Object.fromEntries(targets.map(action => [action.roomId, true])) }));
    setUpdateError('');
    setNotice(null);
    try {
      const results = await settleRoomActions(targets, async action => {
        const current = liveRooms.current.find(room => room._id === action.roomId);
        if (currentView.current.date !== action.date || !canRetrySync(current, action)) {
          throw new Error('The room changed. Review its current state before trying again.');
        }
        const { data } = await api.put(`/housekeeper/${action.roomId}`, guardedChanges(current, action.changes));
        return { current, updated: data.data || data, warning: data.warning };
      });
      const saved = new Map();
      const failures = [];
      let repaired = 0;
      results.forEach((result, index) => {
        const action = targets[index];
        if (result.status === 'fulfilled') {
          const { current, updated, warning } = result.value;
          saved.set(action.roomId, updated);
          recordSyncOutcome(current, updated, action.changes, warning);
          if (!warning) repaired++;
        } else failures.push(`Room ${action.number}: ${requestError(result.reason, 'Sync was not repaired. Please try again.')}`);
      });
      if (hadFocus && (document.activeElement === actionButton || document.activeElement === document.body) &&
        currentView.current.tab === activeTab && currentView.current.date === selectedDate) {
        focusAfterSave.current = { button: actionButton, tab: activeTab, date: selectedDate };
      }
      if (saved.size) setRooms(current => current.map(room => saved.has(room._id) ? mergeRoomRecord(room, saved.get(room._id)) : room));
      setNotice({ message: repaired ? `${repaired} ${repaired === 1 ? 'room' : 'rooms'} synced to front desk.` : 'Front desk sync was not completed.', roomId: null });
      if (failures.length) { setUpdateError(failures.join(' ')); refresh(); }
    } finally {
      targets.forEach(action => pendingIds.current.delete(action.roomId));
      setPending(current => {
        const next = { ...current };
        targets.forEach(action => delete next[action.roomId]);
        return next;
      });
      bulkLock.current = false;
      setBulkBusy(false);
    }
  };

  const changeDate = date => { if (bulkLock.current) return; setSelectedDate(date); setActiveTab('ready'); setNotice(null); setUpdateError(''); };
  const resetFilters = () => { if (bulkLock.current) return; setSearch(''); setAttendantFilter('all'); };
  const viewReadyRooms = () => { if (bulkLock.current) return; resetFilters(); setActiveTab('ready'); };
  const navigateTabs = (event, index) => {
    if (bulkLock.current) return;
    let nextIndex;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % TABS.length;
    if (event.key === 'ArrowLeft') nextIndex = (index - 1 + TABS.length) % TABS.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = TABS.length - 1;
    if (nextIndex === undefined) return;
    event.preventDefault();
    const nextTab = TABS[nextIndex].id;
    setActiveTab(nextTab);
    tabButtons.current.get(nextTab)?.focus();
  };
  const sectionProps = { fresh, canUpdate, pending, onComplete: updateStatus, selecting: selectionMode && canSelect, selectedRooms, selectionDisabled: bulkBusy, onSelect: toggleRoomSelection, date: selectedDate };
  const hint = canUpdate ? selectedTab.hint : {
    ready: 'These rooms are vacant. Housekeeping marks them clean after finishing.',
    services: 'These guests are staying. Housekeeping marks their room service complete.',
    done: 'Clean rooms and completed stayover services.'
  }[activeTab] || selectedTab.hint;
  const hasToasts = freshRooms.length > 0 || Boolean(notice) || Boolean(updateError) || activeSyncActions.length > 0;

  return <div className={`room-page housekeeping-page${hasToasts ? ' has-toasts' : ''}`}>
    <div className="hk-header">
      <div><h1>Housekeeping</h1><p className="hk-date">{selectedDate === today ? <span>Today · {displayDate}</span> : <><span className="hk-not-today">{displayDate} · not today</span><button type="button" onClick={() => changeDate(today)} disabled={busy} className="text-action">Go to today</button></>}</p></div>
      <LiveConnection connected={connected} error={error} />
    </div>
    <div className="hk-task-tabs" role="tablist" aria-label="Room tasks">{TABS.map((tab, index) => <button type="button" key={tab.id} id={`hk-tab-${tab.id}`} role="tab" aria-selected={activeTab === tab.id} aria-controls="hk-task-panel" tabIndex={activeTab === tab.id ? 0 : -1} disabled={bulkBusy} ref={button => { if (button) tabButtons.current.set(tab.id, button); else tabButtons.current.delete(tab.id); }} onClick={() => { if (!bulkLock.current) setActiveTab(tab.id); }} onKeyDown={event => navigateTabs(event, index)} className={`hk-task-tab hk-tab-${tab.id}`}><span>{tab.label}</span><b>{tabCounts[tab.id]}</b></button>)}</div>
    <div className="hk-progress"><p>{counts.actionable ? <><b>{counts.done}</b> of {counts.actionable} done</> : 'Nothing to clean yet'}</p><progress aria-label="Rooms completed" value={counts.done} max={counts.actionable || 1} /></div>
    <details className="board-options hk-options"><summary>Change date or find a room</summary><div className="hk-options-content">
      <DateSelector date={selectedDate} onChange={changeDate} disabled={busy} />
      <div className="hk-field"><label htmlFor="housekeeping-room-filter">Find a room</label><input id="housekeeping-room-filter" type="search" placeholder="Room number" value={search} disabled={bulkBusy} onChange={event => setSearch(event.target.value)} /></div>
      {attendants.length || attendantFilter !== 'all' ? <div className="hk-field"><label htmlFor="housekeeping-attendant-filter">Assigned attendant</label><select id="housekeeping-attendant-filter" value={attendantFilter} disabled={bulkBusy} onChange={event => setAttendantFilter(event.target.value)}><option value="all">All attendants</option><option value="unassigned">Unassigned</option>{attendants.map(name => <option key={name} value={name}>{name}</option>)}</select></div> : null}
      <button type="button" disabled={loading || busy} onClick={refresh} className="secondary-action">Refresh rooms</button>
    </div></details>
    {filtered && visibleEntries.length ? <p className="hk-filter-note">Showing {visibleEntries.length} of {tabCounts[activeTab]} rooms<button type="button" disabled={bulkBusy} onClick={resetFilters} className="text-action">Clear filters</button></p> : null}
    {canUpdate && rooms.length > 0 ? <div className="hk-selection-controls"><button type="button" className="hk-select-toggle" aria-label="Select rooms" aria-pressed={selectionMode && canSelect} disabled={!canSelect || loading || busy} onClick={() => { setSelectionMode(current => !current); setSelectedRooms(new Map()); }}>{selectionMode && canSelect ? 'Finish selecting' : 'Select rooms'}</button>{!canSelect ? <p className="hk-selection-hint">{activeTab === 'waiting' ? 'Rooms can be cleaned after front desk confirms checkout.' : 'Unavailable rooms must be released before cleaning.'}</p> : null}</div> : null}
    {selectionMode && canSelect ? <div ref={selectionToolbar} className="hk-selection-toolbar" role="region" aria-label="Selected rooms" aria-busy={bulkBusy} tabIndex={-1}>
      <div className="hk-selection-count"><strong aria-live="polite">{selectedEntries.length} selected</strong><button type="button" className="text-action" aria-label="Select all visible rooms" disabled={loading || busy || !selectableEntries.length} onClick={() => setSelectedRooms(new Map(selectableEntries.map(({ room }) => [room._id, operationalSignature(room, selectedDate)])))}>Select all</button><button type="button" className="text-action" disabled={busy || !selectedEntries.length} onClick={() => setSelectedRooms(new Map())}>Clear selection</button></div>
      <div className="hk-selection-actions">{activeTab !== 'done' ? <button type="button" className="hk-bulk-action" aria-label={activeTab === 'services' ? 'Mark selected services done' : 'Mark selected rooms clean'} disabled={loading || busy || !selectedToComplete.length} onClick={event => updateSelected(false, event.currentTarget)}>{activeTab === 'services' ? 'Mark service done' : 'Mark clean'} ({selectedToComplete.length})</button> : null}{activeTab !== 'ready' ? <button type="button" className="hk-bulk-revert" aria-label="Revert selected rooms" disabled={loading || busy || !selectedToRevert.length} onClick={event => updateSelected(true, event.currentTarget)}>Revert selected ({selectedToRevert.length})</button> : null}</div>
      {bulkBusy ? <p role="status">Saving selected rooms…</p> : null}
    </div> : null}
    {error ? <div role="alert" className="board-notice notice-error"><p>{error}</p><button type="button" disabled={bulkBusy} onClick={refresh} className="text-action">Try again</button></div> : null}
    {/* A refresh must not shift the boxes under a finger that is about to tap. */}
    {loading ? <p role="status" className={rooms.length ? 'sr-only' : 'board-loading'}>{rooms.length ? 'Refreshing rooms…' : 'Loading rooms…'}</p> : null}
    <div ref={panelRef} role="tabpanel" id="hk-task-panel" aria-labelledby={`hk-tab-${activeTab}`} tabIndex={0}>
    {(!loading || rooms.length > 0) && (!error || rooms.length > 0) ? (rooms.length === 0
      ? <div className="empty-state"><h2>No rooms for {selectedDate}</h2><p>{canImport ? 'Upload the morning PDF to get started.' : 'The front desk needs to upload the morning PDF.'}</p>{canImport ? <Link to={`/upload-report?date=${selectedDate}`} className="text-action">Upload PDF</Link> : null}</div>
      : visibleEntries.length === 0 ? <div className="empty-state hk-tab-empty"><h2>{filtered && tabCounts[activeTab] ? 'No rooms match' : selectedTab.empty}</h2><p>{filtered && tabCounts[activeTab] ? 'Try another room number or attendant.' : selectedTab.emptyHint}</p>{filtered ? <button type="button" disabled={bulkBusy} onClick={resetFilters} className="text-action">Clear filters</button> : null}</div>
      : <RoomSection id={`hk-section-${activeTab}`} title={selectedTab.title} hint={hint} colorKey={selectedTab.colorKey} entries={visibleEntries} {...sectionProps} />) : null}
    </div>
    <div className="hk-toasts">
      <div className="hk-toast-stack" aria-live="polite">
        {freshRooms.length ? <div className="hk-toast hk-toast-new"><span>{freshRooms.length === 1 ? `Room ${freshRooms[0]}` : `Rooms ${freshRooms.join(', ')}`} checked out. Ready to clean.</span>{activeTab !== 'ready' ? <button type="button" disabled={bulkBusy} onClick={viewReadyRooms} className="hk-toast-action">View ready rooms</button> : null}<button type="button" onClick={() => setFresh(new Set())} aria-label="Dismiss checkout alert" className="hk-toast-dismiss">×</button></div> : null}
        {notice ? <div className="hk-toast hk-toast-done"><span>{notice.message}</span>{undoRoom ? <button type="button" onClick={event => updateStatus(undoRoom, true, event.currentTarget)} disabled={busy} aria-label={`Undo room ${roomNumber(undoRoom)}`} className="hk-toast-action">Undo</button> : null}<button type="button" onClick={() => setNotice(null)} aria-label="Dismiss message" className="hk-toast-dismiss">×</button></div> : null}
      </div>
      {updateError || activeSyncActions.length ? <div role="alert" className={`hk-toast hk-toast-error${activeSyncActions.length ? ' hk-toast-sync' : ''}`}>
        <span>{updateError ? <span>{updateError}</span> : null}{activeSyncActions.map(action => <span key={action.roomId}>Room {action.number}: {action.warning} Saved here; front desk sync needs retry.{!canRetrySync(rooms.find(room => room._id === action.roomId), action) ? ` Room ${action.number} changed. Review its current state before retrying sync.` : ''}</span>)}</span>
        {activeSyncActions.length && canUpdate ? <button type="button" className="hk-toast-action" aria-label="Retry housekeeping sync" disabled={busy || loading || !retryableSyncActions.length} onClick={event => retrySync(event.currentTarget)}>Retry sync</button> : null}
        {activeSyncActions.length ? <button type="button" className="hk-toast-dismiss" aria-label="Dismiss sync warning" title="Dismiss sync warning" disabled={busy} onClick={() => { if (!bulkLock.current) setSyncActions(current => new Map([...current].filter(([, action]) => action.date !== selectedDate))); }}>×</button> : null}
        {updateError ? <button type="button" onClick={() => setUpdateError('')} aria-label="Dismiss error" className="hk-toast-dismiss">×</button> : null}
      </div> : null}
    </div>
  </div>;
}
