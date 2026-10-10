import React from 'react';
import { useSearchParams } from 'react-router-dom';
import { isReportDate, localDate, shiftDate } from '../utils/roomData';

export function useReportDate() {
  const [params, setParams] = useSearchParams();
  const requestedDate = params.get('date');
  const date = isReportDate(requestedDate) ? requestedDate : localDate();
  const setDate = (value) => {
    if (!isReportDate(value)) return;
    setParams(previous => {
      const next = new URLSearchParams(previous);
      next.set('date', value);
      return next;
    }, { replace: true });
  };
  return [date, setDate];
}

export default function DateSelector({ date, onChange, disabled = false, id = 'report-date' }) {
  return (
    <div className="date-selector">
      <label htmlFor={id} className="text-sm font-medium text-gray-700">Report date</label>
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => onChange(shiftDate(date, -1))} disabled={disabled} aria-label="Previous report date" className="date-step">‹</button>
        <input id={id} type="date" value={date} onChange={event => onChange(event.target.value)} disabled={disabled} required className="px-3 py-2 border border-gray-300 rounded-lg" />
        <button type="button" onClick={() => onChange(shiftDate(date, 1))} disabled={disabled} aria-label="Next report date" className="date-step">›</button>
      </div>
      <button type="button" disabled={disabled || date === localDate()} onClick={() => onChange(localDate())} className="text-sm text-blue-700 hover:underline disabled:text-gray-400">Today</button>
    </div>
  );
}
