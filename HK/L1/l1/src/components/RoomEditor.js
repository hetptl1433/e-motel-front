import React, { useEffect, useId, useRef } from 'react';
import { HOUSEKEEPING_STATUSES, isReportDate, isRoomUnavailable, roomNumber } from '../utils/roomData';

export const ROOM_INPUT_CLASS = 'room-input';

export function DeskField({ label, children, className = '' }) {
  const id = useId();
  return <div className={`editor-field ${className}`}>
    <label htmlFor={id}>{label}</label>
    {React.cloneElement(children, { id })}
  </div>;
}

export default function RoomEditor({ room, draft, fullEdit, saving, error, onChange, onCancel, onSave }) {
  const form = useRef(null);
  const cleaningLocked = !fullEdit && (isRoomUnavailable(room) || room.occupancyStatus !== 'Vacant');
  useEffect(() => {
    form.current?.querySelector('select:not(:disabled), input:not(:disabled), textarea:not(:disabled)')?.focus();
  }, [room._id]);

  return <form ref={form} onSubmit={onSave} className="room-editor" aria-label={`Edit room ${roomNumber(room)}`}>
    <div className="editor-heading"><h3>Edit room {roomNumber(room)}</h3><p>Save your changes to update the shared room board.</p></div>
    <fieldset disabled={saving} className="editor-grid">
      <DeskField label="Housekeeping"><select value={draft.housekeepingStatus} disabled={cleaningLocked} onChange={event => onChange('housekeepingStatus', event.target.value)} className={ROOM_INPUT_CLASS}>
        {!HOUSEKEEPING_STATUSES.includes(draft.housekeepingStatus) ? <option>{draft.housekeepingStatus}</option> : null}
        {HOUSEKEEPING_STATUSES.map(status => <option key={status}>{status}</option>)}
      </select></DeskField>
      {cleaningLocked ? <p className="editor-help editor-wide">Wait for the front desk to release this room. You can update its notes.</p> : null}
      {fullEdit ? <>
        <DeskField label="Occupancy"><select value={draft.occupancyStatus} onChange={event => onChange('occupancyStatus', event.target.value)} className={ROOM_INPUT_CLASS}><option>Vacant</option><option>Occupied</option></select></DeskField>
        <DeskField label="Guest Status"><select value={draft.guestStatus} onChange={event => onChange('guestStatus', event.target.value)} className={ROOM_INPUT_CLASS}>
          <option value="">None</option>
          {draft.guestStatus && !['Checked-in', 'Checked-out', 'Due-out'].includes(draft.guestStatus) ? <option>{draft.guestStatus}</option> : null}
          <option>Checked-in</option><option>Checked-out</option><option>Due-out</option>
        </select></DeskField>
        <DeskField label="Order status"><select value={draft.orderStatus} onChange={event => onChange('orderStatus', event.target.value)} className={ROOM_INPUT_CLASS}>
          <option value="">In order</option>
          {draft.orderStatus && !['OOI/OI', 'Out of Service'].includes(draft.orderStatus) ? <option>{draft.orderStatus}</option> : null}
          <option value="OOI/OI">Out of Order (OOI/OI)</option><option>Out of Service</option>
        </select></DeskField>
        {['checkIn', 'checkOut'].map(field => <DeskField key={field} label={field === 'checkIn' ? 'Check-in' : 'Check-out'}><input type={!draft[field] || isReportDate(draft[field]) ? 'date' : 'text'} value={draft[field]} onChange={event => onChange(field, event.target.value)} className={ROOM_INPUT_CLASS} /></DeskField>)}
        <DeskField label="Assigned Attendant"><input value={draft.assignedAttendant} onChange={event => onChange('assignedAttendant', event.target.value)} maxLength={100} className={ROOM_INPUT_CLASS} /></DeskField>
        <label className="editor-checkbox"><input type="checkbox" checked={draft.pet} onChange={event => onChange('pet', event.target.checked)} />Pet in Room</label>
        <DeskField label="Issue / reason" className="editor-wide"><input value={draft.reason} onChange={event => onChange('reason', event.target.value)} maxLength={1000} className={ROOM_INPUT_CLASS} /></DeskField>
        <DeskField label="Description" className="editor-wide"><textarea value={draft.description} onChange={event => onChange('description', event.target.value)} maxLength={2000} rows={2} className={ROOM_INPUT_CLASS} /></DeskField>
      </> : null}
      <DeskField label="Notes" className="editor-wide"><textarea value={draft.notes} onChange={event => onChange('notes', event.target.value)} maxLength={2000} rows={3} className={ROOM_INPUT_CLASS} /></DeskField>
    </fieldset>
    {error ? <p role="alert" className="editor-error">{error}</p> : null}
    <div className="editor-actions"><button type="button" onClick={onCancel} disabled={saving} className="secondary-action">Cancel</button><button type="submit" disabled={saving} className="primary-action">{saving ? 'Saving…' : 'Save'}</button></div>
  </form>;
}
