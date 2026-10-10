import React from 'react';
import { roomWorkflow } from '../utils/roomData';

export const WORKFLOW_LABELS = {
  ready: 'Ready to clean', waiting: 'Waiting for checkout', stayover: 'Stayovers', done: 'Done', unavailable: 'Unavailable'
};
const defaultStatuses = ['ready', 'waiting', 'done', 'unavailable'];

export function workflowCounts(rooms, workflowOf = roomWorkflow) {
  const counts = { all: rooms.length, ready: 0, waiting: 0, stayover: 0, done: 0, unavailable: 0 };
  rooms.forEach(room => { counts[workflowOf(room)] += 1; });
  return counts;
}

export function WorkflowStatus({ workflow }) {
  return <span className={`workflow-status filter-${workflow}`}><span aria-hidden="true" className="workflow-dot" />{WORKFLOW_LABELS[workflow]}</span>;
}

export function WorkflowSummary({ rooms, workflowOf, statuses = defaultStatuses }) {
  const counts = workflowCounts(rooms, workflowOf);
  return <div className={`workflow-summary${statuses.length === 5 ? ' has-five-statuses' : ''}`} aria-label="Room status totals">
    {statuses.map(status => <div key={status} className={`summary-item filter-${status}`}>
      <span aria-hidden="true" className="workflow-dot" /><div><strong>{counts[status]}</strong><span>{WORKFLOW_LABELS[status]}</span></div>
    </div>)}
  </div>;
}

export function LiveConnection({ connected, error }) {
  return <span role="status" className={`live-connection ${connected && !error ? 'is-live' : ''}`}>
    <span aria-hidden="true" className="connection-dot" />
    {error ? 'Unable to load rooms' : connected ? 'Live updates' : 'Reconnecting · checks every 30 sec'}
  </span>;
}

export function WorkflowFilters({ rooms, value, onChange, disabled = false, workflowOf, statuses = defaultStatuses }) {
  const counts = workflowCounts(rooms, workflowOf);
  return <div className="workflow-filters" role="group" aria-label="Filter rooms by status">
    {['all', ...statuses].map(status => <button key={status} type="button"
      className={`workflow-filter filter-${status} ${value === status ? 'is-selected' : ''}`}
      disabled={disabled} aria-pressed={value === status} onClick={() => onChange(status)}>
      <span aria-hidden="true" className="workflow-dot" />
      <span>{status === 'all' ? 'All rooms' : WORKFLOW_LABELS[status]}</span>
      <strong>{counts[status]}</strong>
    </button>)}
  </div>;
}

export function WorkflowLegend({ statuses = defaultStatuses }) {
  return <div className="workflow-legend" aria-label="Room colors">
    {statuses.map(status => <span key={status} className={`filter-${status}`}>
      <span aria-hidden="true" className="workflow-dot" />{WORKFLOW_LABELS[status]}
    </span>)}
  </div>;
}
