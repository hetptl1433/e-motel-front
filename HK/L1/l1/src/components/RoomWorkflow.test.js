import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext } from '../context/authContext';
import api from '../api';
import useRoomRealtime from '../hooks/useRoomRealtime';
import HouseKeeping from './houseKeeping';
import Dashboard from './Dashboard';

jest.mock('../api', () => ({ __esModule: true, default: { get: jest.fn(), put: jest.fn(), post: jest.fn() } }));
jest.mock('../hooks/useRoomRealtime', () => ({ __esModule: true, default: jest.fn() }));

const rooms = [
  { _id: 'ready', roomNumber: '101', housekeepingStatus: 'Dirty', occupancyStatus: 'Vacant', assignedAttendant: 'Maria', notes: 'Extra towels', pet: true, checkIn: '2026-10-01', checkOut: '2026-10-03' },
  { _id: 'waiting', roomNumber: '102', housekeepingStatus: 'Dirty', occupancyStatus: 'Occupied', assignedAttendant: 'Maria', checkIn: '2026-10-02', checkOut: '2026-10-04' },
  { _id: 'done', roomNumber: '103', housekeepingStatus: 'Clean', occupancyStatus: 'Vacant', assignedAttendant: 'Ana' },
  { _id: 'blocked', roomNumber: '104', housekeepingStatus: 'Clean', occupancyStatus: 'Vacant', orderStatus: 'OOI/OI', reason: 'Air conditioning repair', description: 'Wait for maintenance release' }
];

const deskRooms = [
  { _id: 'desk-stayover', roomNumber: '101', reportDate: '2026-10-03', housekeepingStatus: 'Dirty', occupancyStatus: 'Occupied', checkOut: '2026-10-04' },
  { _id: 'desk-due', roomNumber: '202', reportDate: '2026-10-03', housekeepingStatus: 'Dirty', occupancyStatus: 'Occupied', guestStatus: 'Due Out', checkOut: '2026-10-04' },
  { _id: 'desk-overdue', roomNumber: '110', reportDate: '2026-10-03', housekeepingStatus: 'Dirty', occupancyStatus: 'Occupied', checkOut: '2026-10-02' },
  { _id: 'desk-ready', roomNumber: '105', reportDate: '2026-10-03', housekeepingStatus: 'Dirty', occupancyStatus: 'Vacant' },
  { _id: 'desk-done', roomNumber: '104', reportDate: '2026-10-03', housekeepingStatus: 'Clean', occupancyStatus: 'Vacant' },
  { _id: 'desk-blocked', roomNumber: '106', reportDate: '2026-10-03', housekeepingStatus: 'Clean', occupancyStatus: 'Vacant', orderStatus: 'OOI/OI' }
];

function open(Component, role = 'housekeeping') {
  return render(<MemoryRouter initialEntries={['/?date=2026-10-03']}><AuthContext.Provider value={{ user: { role }, token: 'test-session' }}><Component /></AuthContext.Provider></MemoryRouter>);
}

function openAllDesk(role = 'frontdesk') {
  const view = open(Dashboard, role);
  fireEvent.click(within(screen.getByRole('group', { name: 'Filter rooms by status' })).getByRole('button', { name: /All rooms/ }));
  return view;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  jest.resetAllMocks();
  localStorage.clear();
  api.get.mockResolvedValue({ data: { data: rooms } });
  useRoomRealtime.mockReturnValue(true);
});

test('one tap marks a red room clean for the front desk, and Undo makes it dirty again', async () => {
  api.put.mockImplementation((url, changes) => Promise.resolve({ data: { data: { ...rooms[0], ...changes } } }));
  open(HouseKeeping);
  const ready = await screen.findByRole('listitem', { name: 'Room 101, Dirty' });
  expect(screen.queryByRole('listitem', { name: /^Room (102|103|104),/ })).not.toBeInTheDocument();
  fireEvent.click(within(ready).getByRole('button', { name: 'Mark room 101 clean' }));
  await screen.findByText('Room 101 is clean. Front desk can see it now.');
  expect(screen.queryByRole('listitem', { name: /^Room 101,/ })).not.toBeInTheDocument();
  expect(api.put).toHaveBeenCalledWith('/housekeeper/ready', { housekeepingStatus: 'Clean' });
  fireEvent.click(screen.getByRole('button', { name: 'Undo room 101' }));
  await screen.findByRole('listitem', { name: 'Room 101, Dirty' });
  expect(api.put).toHaveBeenLastCalledWith('/housekeeper/ready', { housekeepingStatus: 'Dirty' });
  expect(screen.getByText('Room 101 is marked dirty again.')).toBeInTheDocument();
});

test('failed cleaning keeps the room red and explains that it was not saved', async () => {
  api.put.mockRejectedValue({ response: { data: { message: 'The room is now occupied. Refresh before cleaning.' } } });
  open(HouseKeeping);
  fireEvent.click(await screen.findByRole('button', { name: 'Mark room 101 clean' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('The room is now occupied');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Mark room 101 clean' })).toBeEnabled());
  expect(screen.queryByRole('listitem', { name: 'Room 101, Clean' })).not.toBeInTheDocument();
});

test('front desk checks out a guest directly and the room becomes ready to clean', async () => {
  api.post.mockResolvedValue({ data: { data: { ...rooms[1], occupancyStatus: 'Vacant', housekeepingStatus: 'Dirty', guestStatus: 'Checked-out' } } });
  openAllDesk();
  fireEvent.click(await screen.findByRole('button', { name: 'Check out room 102' }));
  expect(api.post).toHaveBeenCalledWith('/room/waiting/checkout');
  await screen.findByRole('article', { name: 'Room 102, Ready to clean' });
  expect(screen.queryByRole('button', { name: 'Check out room 102' })).not.toBeInTheDocument();
  expect(screen.getByText('Room 102 checked out. Housekeeping can now clean it.')).toBeInTheDocument();
});

test('front desk housekeeping view is read-only and a housekeeping account cannot check out guests', async () => {
  const view = open(HouseKeeping, 'frontdesk');
  await screen.findByRole('listitem', { name: 'Room 101, Dirty' });
  expect(screen.queryByRole('button', { name: /^Mark room/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab', { name: 'Services 1' }));
  expect(screen.getByRole('listitem', { name: 'Room 102, Service not done' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^Mark room/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab', { name: 'Done 1' }));
  expect(screen.getByRole('listitem', { name: 'Room 103, Clean' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^Revert room/ })).not.toBeInTheDocument();
  view.unmount();
  openAllDesk('housekeeping');
  await screen.findByRole('article', { name: 'Room 102, Stayovers' });
  expect(screen.queryByRole('button', { name: /Check out room/ })).not.toBeInTheDocument();
});

test('front desk sees live whether stayover service is done', async () => {
  openAllDesk();
  expect(within(await screen.findByRole('article', { name: 'Room 102, Stayovers' })).getByText('Stayover · Service not done')).toBeInTheDocument();
  expect(within(screen.getByRole('article', { name: 'Room 101, Ready to clean' })).getByText('Vacant')).toBeInTheDocument();
  const { setRooms } = useRoomRealtime.mock.calls[useRoomRealtime.mock.calls.length - 1][0];
  act(() => setRooms(previous => previous.map(room => room._id === 'waiting' ? { ...room, stayoverServicedAt: '2026-10-03T15:00:00.000Z' } : room)));
  expect(within(screen.getByRole('article', { name: 'Room 102, Stayovers' })).getByText('Stayover · Service done')).toBeInTheDocument();
});

test('housekeeping narrows the selected tab by room number and attendant and clears filters without changing tabs', async () => {
  open(HouseKeeping);
  await screen.findByRole('listitem', { name: 'Room 101, Dirty' });
  expect(within(screen.getByRole('listitem', { name: 'Notes for room 101' })).getByText('Extra towels')).toBeInTheDocument();
  expect(within(screen.getByRole('listitem', { name: 'Notes for room 101' })).getByText('Pet in room')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab', { name: 'Unavailable 1' }));
  const unavailable = screen.getByRole('listitem', { name: 'Notes for room 104' });
  expect(within(unavailable).getByText('Air conditioning repair')).toBeInTheDocument();
  expect(within(unavailable).getByText('Wait for maintenance release')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab', { name: 'Ready to clean 1' }));

  fireEvent.click(screen.getByText('Change date or find a room'));
  fireEvent.change(screen.getByRole('searchbox', { name: 'Find a room' }), { target: { value: '10' } });
  fireEvent.change(screen.getByLabelText('Assigned attendant'), { target: { value: 'Maria' } });
  expect(screen.getByText(/Showing 1 of 1 rooms/)).toBeInTheDocument();
  expect(screen.getByRole('listitem', { name: 'Room 101, Dirty' })).toBeInTheDocument();
  expect(screen.queryByRole('listitem', { name: 'Room 102, Service not done' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab', { name: 'Services 1' }));
  expect(screen.getByRole('listitem', { name: 'Room 102, Service not done' })).toBeInTheDocument();
  expect(screen.queryByRole('listitem', { name: 'Room 103, Clean' })).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole('searchbox', { name: 'Find a room' }), { target: { value: '101' } });
  expect(screen.queryByRole('listitem', { name: /^Room / })).not.toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'No rooms match' })).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Assigned attendant'), { target: { value: 'Ana' } });
  expect(screen.getByRole('heading', { name: 'No rooms match' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
  expect(screen.getByRole('tab', { name: 'Services 1' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('listitem', { name: 'Room 102, Service not done' })).toBeInTheDocument();
  expect(screen.queryByRole('listitem', { name: 'Room 103, Clean' })).not.toBeInTheDocument();
  expect(screen.queryByText(/Showing \d+ of/)).not.toBeInTheDocument();
  expect(screen.getByRole('searchbox', { name: 'Find a room' })).toHaveValue('');
  expect(screen.getByLabelText('Assigned attendant')).toHaveValue('all');
});

test.each([
  ['housekeeping', HouseKeeping, '/housekeeper', { role: 'listitem', name: 'Room 101, Dirty' }],
  ['frontdesk', Dashboard, '/room/status/2026-10-04', { role: 'article', name: 'Room 101, Ready to clean' }]
])('%s loads only the newly selected report date', async (role, Component, endpoint, readyRoom) => {
  api.get.mockImplementation((url, config) => Promise.resolve({ data: { data: config.params.date === '2026-10-03' ? rooms : [] } }));
  open(Component, role);
  if (role === 'frontdesk') fireEvent.click(within(screen.getByRole('group', { name: 'Filter rooms by status' })).getByRole('button', { name: /All rooms/ }));
  await screen.findByRole(readyRoom.role, { name: readyRoom.name });
  if (role === 'housekeeping') fireEvent.click(screen.getByText('Change date or find a room'));
  fireEvent.click(screen.getByRole('button', { name: 'Next report date' }));
  await waitFor(() => expect(api.get).toHaveBeenLastCalledWith(endpoint, expect.objectContaining({ params: { date: '2026-10-04' } })));
  expect(await screen.findByRole('heading', { name: /No (rooms|room report) for 2026-10-04/ })).toBeInTheDocument();
  expect(screen.queryByRole(readyRoom.role, { name: /^Room 101/ })).not.toBeInTheDocument();
});

test('front desk combines room search, occupancy, pet, and stay-date filters', async () => {
  openAllDesk();
  await screen.findByRole('article', { name: 'Room 101, Ready to clean' });
  fireEvent.change(screen.getByRole('searchbox', { name: 'Find a room' }), { target: { value: '10' } });
  fireEvent.click(screen.getByText('More filters and report tools'));
  fireEvent.change(screen.getByLabelText('Occupancy'), { target: { value: 'Vacant' } });
  fireEvent.change(screen.getByLabelText('Pet Status'), { target: { value: 'yes' } });
  fireEvent.change(screen.getByLabelText('Date Filter Type'), { target: { value: 'checkOut' } });
  fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-03' } });
  fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-03' } });
  expect(screen.getAllByRole('article')).toHaveLength(1);
  expect(screen.getByRole('article')).toHaveAccessibleName('Room 101, Ready to clean');
  fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-04' } });
  expect(screen.getByRole('alert')).toHaveTextContent('The end date must be on or after the start date.');
  fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
  expect(screen.getAllByRole('article')).toHaveLength(4);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('front desk editor saves only changed fields and locks date navigation while editing', async () => {
  api.put.mockImplementation((url, changes) => Promise.resolve({ data: { data: { ...rooms[0], ...changes } } }));
  openAllDesk();
  fireEvent.click(await screen.findByRole('button', { name: 'Edit room 101' }));
  const editor = screen.getByRole('form', { name: 'Edit room 101' });
  expect(within(editor).getByLabelText('Housekeeping')).toHaveFocus();
  expect(screen.getByLabelText('Report date')).toBeDisabled();
  expect(screen.getByRole('searchbox', { name: 'Find a room' })).toBeDisabled();
  expect(within(screen.getByRole('group', { name: 'Filter rooms by status' })).getByRole('button', { name: /Ready to clean/ })).toBeDisabled();
  fireEvent.change(within(editor).getByLabelText('Notes'), { target: { value: 'Leave extra pillows' } });
  fireEvent.change(within(editor).getByLabelText('Assigned Attendant'), { target: { value: 'Ana' } });
  fireEvent.click(within(editor).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(api.put).toHaveBeenCalledWith('/room/ready', { notes: 'Leave extra pillows', assignedAttendant: 'Ana' }));
  await waitFor(() => expect(screen.queryByRole('form', { name: 'Edit room 101' })).not.toBeInTheDocument());
  expect(within(screen.getByRole('article', { name: 'Room 101, Ready to clean' })).getByText('Leave extra pillows')).toBeInTheDocument();
  expect(screen.getByLabelText('Report date')).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Edit room 101' })).toHaveFocus();
});

test('a live status change keeps the filtered room draft available and preserves that status on save', async () => {
  api.put.mockImplementation((url, changes) => Promise.resolve({ data: { data: { ...rooms[0], housekeepingStatus: 'Clean', ...changes } } }));
  openAllDesk();
  await screen.findByRole('article', { name: 'Room 101, Ready to clean' });
  const statusFilters = screen.getByRole('group', { name: 'Filter rooms by status' });
  fireEvent.click(within(statusFilters).getByRole('button', { name: /Ready to clean/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Edit room 101' }));
  const editor = screen.getByRole('form', { name: 'Edit room 101' });
  fireEvent.change(within(editor).getByLabelText('Notes'), { target: { value: 'Leave extra pillows' } });

  const { setRooms } = useRoomRealtime.mock.calls[useRoomRealtime.mock.calls.length - 1][0];
  act(() => setRooms(previous => previous.map(room => room._id === 'ready' ? { ...room, housekeepingStatus: 'Clean' } : room)));

  expect(screen.getByRole('article', { name: 'Room 101, Done' })).toContainElement(editor);
  expect(within(editor).getByLabelText('Notes')).toHaveValue('Leave extra pillows');
  expect(screen.getByLabelText('Report date')).toBeDisabled();
  fireEvent.click(within(editor).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(api.put).toHaveBeenCalledWith('/room/ready', { notes: 'Leave extra pillows' }));
  await waitFor(() => expect(screen.queryByRole('form', { name: 'Edit room 101' })).not.toBeInTheDocument());
  expect(screen.queryByRole('article', { name: 'Room 101, Done' })).not.toBeInTheDocument();
  expect(within(statusFilters).getByRole('button', { name: /Ready to clean/ })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByLabelText('Report date')).toBeEnabled();
  fireEvent.click(within(statusFilters).getByRole('button', { name: /All rooms/ }));
  expect(within(screen.getByRole('article', { name: 'Room 101, Done' })).getByText('Leave extra pillows')).toBeInTheDocument();
});

test('cancelling an editor returns keyboard focus to its room action', async () => {
  openAllDesk();
  fireEvent.click(await screen.findByRole('button', { name: 'Edit room 101' }));
  const editor = screen.getByRole('form', { name: 'Edit room 101' });
  within(editor).getByLabelText('Notes').focus();
  fireEvent.click(within(editor).getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('form', { name: 'Edit room 101' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Edit room 101' })).toHaveFocus();
  expect(api.put).not.toHaveBeenCalled();
});

test('front desk rejects a check-out before check-in without discarding the edit', async () => {
  openAllDesk();
  fireEvent.click(await screen.findByRole('button', { name: 'Edit room 101' }));
  const editor = screen.getByRole('form', { name: 'Edit room 101' });
  fireEvent.change(within(editor).getByLabelText('Check-out'), { target: { value: '2026-09-30' } });
  fireEvent.click(within(editor).getByRole('button', { name: 'Save' }));
  expect(within(editor).getByRole('alert')).toHaveTextContent('Check-out must be on or after check-in.');
  expect(api.put).not.toHaveBeenCalled();
  expect(within(editor).getByLabelText('Check-out')).toHaveValue('2026-09-30');
  expect(within(editor).getByRole('button', { name: 'Save' })).toBeEnabled();
});

test('a failed front desk save retains the draft for retry', async () => {
  api.put.mockRejectedValueOnce({ response: { data: { message: 'The room changed. Review it and try again.' } } });
  api.put.mockImplementation((url, changes) => Promise.resolve({ data: { data: { ...rooms[0], ...changes } } }));
  openAllDesk();
  fireEvent.click(await screen.findByRole('button', { name: 'Edit room 101' }));
  const editor = screen.getByRole('form', { name: 'Edit room 101' });
  fireEvent.change(within(editor).getByLabelText('Notes'), { target: { value: 'Bring a crib' } });
  fireEvent.click(within(editor).getByRole('button', { name: 'Save' }));
  expect(await within(editor).findByRole('alert')).toHaveTextContent('The room changed');
  expect(within(editor).getByLabelText('Notes')).toHaveValue('Bring a crib');
  await waitFor(() => expect(within(editor).getByRole('button', { name: 'Save' })).toBeEnabled());
  fireEvent.click(within(editor).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(screen.queryByRole('form', { name: 'Edit room 101' })).not.toBeInTheDocument());
  expect(api.put).toHaveBeenLastCalledWith('/room/ready', { notes: 'Bring a crib' });
});

test('a housekeeping account can edit stayover-room notes but cannot change guest details or cleaning status', async () => {
  api.put.mockImplementation((url, changes) => Promise.resolve({ data: { data: { ...rooms[1], ...changes } } }));
  openAllDesk('housekeeping');
  fireEvent.click(await screen.findByRole('button', { name: 'Edit room 102' }));
  const editor = screen.getByRole('form', { name: 'Edit room 102' });
  expect(within(editor).getByLabelText('Housekeeping')).toBeDisabled();
  expect(within(editor).getByLabelText('Notes')).toHaveFocus();
  for (const label of ['Occupancy', 'Guest Status', 'Assigned Attendant', 'Check-in', 'Check-out', 'Pet in Room']) {
    expect(within(editor).queryByLabelText(label)).not.toBeInTheDocument();
  }
  fireEvent.change(within(editor).getByLabelText('Notes'), { target: { value: 'Guest requested towels' } });
  fireEvent.click(within(editor).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(api.put).toHaveBeenCalledWith('/room/waiting', { notes: 'Guest requested towels' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Edit room 102' })).toHaveFocus());
});

test('front desk defaults to Boxes and remembers the selected layout without refreshing rooms', async () => {
  const view = openAllDesk();
  await screen.findByRole('article', { name: 'Room 101, Ready to clean' });
  const layout = screen.getByRole('group', { name: 'Room layout' });
  expect(within(layout).getByRole('button', { name: 'Boxes' })).toHaveAttribute('aria-pressed', 'true');
  expect(within(layout).getByRole('button', { name: 'Table' })).toHaveAttribute('aria-pressed', 'false');
  const initialReads = api.get.mock.calls.length;
  fireEvent.click(within(layout).getByRole('button', { name: 'Table' }));
  expect(within(layout).getByRole('button', { name: 'Table' })).toHaveAttribute('aria-pressed', 'true');
  expect(within(layout).getByRole('button', { name: 'Boxes' })).toHaveAttribute('aria-pressed', 'false');
  expect(localStorage.getItem('motel.frontdesk.layout.v1')).toBe('table');
  expect(api.get).toHaveBeenCalledTimes(initialReads);

  view.unmount();
  const { unmount } = openAllDesk();
  await screen.findByRole('article', { name: 'Room 101, Ready to clean' });
  const restoredLayout = screen.getByRole('group', { name: 'Room layout' });
  expect(within(restoredLayout).getByRole('button', { name: 'Table' })).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(within(restoredLayout).getByRole('button', { name: 'Boxes' }));
  expect(localStorage.getItem('motel.frontdesk.layout.v1')).toBe('boxes');
  unmount();
  openAllDesk();
  await screen.findByRole('article', { name: 'Room 101, Ready to clean' });
  expect(within(screen.getByRole('group', { name: 'Room layout' })).getByRole('button', { name: 'Boxes' })).toHaveAttribute('aria-pressed', 'true');
});

test('switching layouts preserves search, filters, the open draft, and live room changes', async () => {
  api.put.mockImplementation((url, changes) => Promise.resolve({ data: { data: { ...rooms[0], housekeepingStatus: 'Clean', ...changes } } }));
  openAllDesk();
  await screen.findByRole('article', { name: 'Room 101, Ready to clean' });
  const statusFilters = screen.getByRole('group', { name: 'Filter rooms by status' });
  fireEvent.change(screen.getByRole('searchbox', { name: 'Find a room' }), { target: { value: '101' } });
  fireEvent.click(within(statusFilters).getByRole('button', { name: /Ready to clean/ }));
  fireEvent.click(screen.getByText('More filters and report tools'));
  fireEvent.change(screen.getByLabelText('Pet Status'), { target: { value: 'yes' } });
  fireEvent.click(screen.getByRole('button', { name: 'Edit room 101' }));
  const editor = screen.getByRole('form', { name: 'Edit room 101' });
  fireEvent.change(within(editor).getByLabelText('Notes'), { target: { value: 'Bring a crib' } });
  const layout = screen.getByRole('group', { name: 'Room layout' });
  expect(within(layout).getByRole('button', { name: 'Boxes' })).toBeEnabled();
  expect(within(layout).getByRole('button', { name: 'Table' })).toBeEnabled();
  const initialReads = api.get.mock.calls.length;
  fireEvent.click(within(layout).getByRole('button', { name: 'Boxes' }));

  expect(screen.getByRole('form', { name: 'Edit room 101' })).toBe(editor);
  expect(within(editor).getByLabelText('Notes')).toHaveValue('Bring a crib');
  expect(screen.getByRole('searchbox', { name: 'Find a room' })).toHaveValue('101');
  expect(screen.getByLabelText('Pet Status')).toHaveValue('yes');
  expect(within(statusFilters).getByRole('button', { name: /Ready to clean/ })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getAllByRole('article')).toHaveLength(1);

  const { setRooms } = useRoomRealtime.mock.calls[useRoomRealtime.mock.calls.length - 1][0];
  act(() => setRooms(previous => previous.map(room => room._id === 'ready' ? { ...room, housekeepingStatus: 'Clean' } : room)));
  expect(screen.getByRole('article', { name: 'Room 101, Done' })).toContainElement(editor);
  fireEvent.click(within(layout).getByRole('button', { name: 'Table' }));
  expect(screen.getByRole('article', { name: 'Room 101, Done' })).toContainElement(editor);
  expect(screen.getByRole('form', { name: 'Edit room 101' })).toBe(editor);
  expect(within(editor).getByLabelText('Notes')).toHaveValue('Bring a crib');
  expect(api.get).toHaveBeenCalledTimes(initialReads);

  fireEvent.click(within(layout).getByRole('button', { name: 'Boxes' }));
  fireEvent.click(within(editor).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(api.put).toHaveBeenCalledWith('/room/ready', { notes: 'Bring a crib' }));
  await waitFor(() => expect(screen.queryByRole('form', { name: 'Edit room 101' })).not.toBeInTheDocument());
  fireEvent.click(within(statusFilters).getByRole('button', { name: /All rooms/ }));
  expect(within(screen.getByRole('article', { name: 'Room 101, Done' })).getByText('Bring a crib')).toBeInTheDocument();
  expect(screen.getAllByRole('article')).toHaveLength(1);
});

test('Boxes uses the shared checkout and room editor workflows', async () => {
  localStorage.setItem('motel.frontdesk.layout.v1', 'boxes');
  const checkedOutRoom = { ...rooms[1], occupancyStatus: 'Vacant', housekeepingStatus: 'Dirty', guestStatus: 'Checked-out' };
  api.post.mockResolvedValue({ data: { data: checkedOutRoom } });
  api.put.mockImplementation((url, changes) => Promise.resolve({ data: { data: { ...checkedOutRoom, ...changes } } }));
  openAllDesk();
  fireEvent.click(await screen.findByRole('button', { name: 'Check out room 102' }));
  expect(api.post).toHaveBeenCalledWith('/room/waiting/checkout');
  await screen.findByRole('article', { name: 'Room 102, Ready to clean' });
  expect(screen.queryByRole('button', { name: 'Check out room 102' })).not.toBeInTheDocument();
  expect(within(screen.getByRole('group', { name: 'Room layout' })).getByRole('button', { name: 'Boxes' })).toHaveAttribute('aria-pressed', 'true');

  fireEvent.click(screen.getByRole('button', { name: 'Edit room 102' }));
  const editor = screen.getByRole('form', { name: 'Edit room 102' });
  fireEvent.change(within(editor).getByLabelText('Notes'), { target: { value: 'Ready for arrival inspection' } });
  fireEvent.click(within(editor).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(api.put).toHaveBeenCalledWith('/room/waiting', { notes: 'Ready for arrival inspection' }));
  await waitFor(() => expect(screen.queryByRole('form', { name: 'Edit room 102' })).not.toBeInTheDocument());
  expect(within(screen.getByRole('article', { name: 'Room 102, Ready to clean' })).getByText('Ready for arrival inspection')).toBeInTheDocument();
});

test('front desk opens the departure queue in Boxes and sorts checkouts first across all rooms', async () => {
  api.get.mockResolvedValue({ data: { data: deskRooms } });
  open(Dashboard, 'frontdesk');
  await screen.findByRole('article', { name: 'Room 110, Waiting for checkout' });
  const statusFilters = screen.getByRole('group', { name: 'Filter rooms by status' });
  expect(within(statusFilters).getByRole('button', { name: /Waiting for checkout/ })).toHaveAttribute('aria-pressed', 'true');
  expect(within(statusFilters).getByRole('button', { name: /Waiting for checkout/ })).toHaveTextContent('2');
  expect(within(statusFilters).getByRole('button', { name: /Stayovers/ })).toHaveTextContent('1');
  expect(within(screen.getByRole('group', { name: 'Room layout' })).getByRole('button', { name: 'Boxes' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getAllByRole('article').map(article => article.getAttribute('aria-label'))).toEqual(['Room 110, Waiting for checkout', 'Room 202, Waiting for checkout']);
  expect(screen.queryByRole('article', { name: 'Room 101, Stayovers' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByText('More filters and report tools'));
  expect(screen.getByLabelText('Sort by')).toHaveValue('status');
  expect(screen.getByRole('option', { name: 'Room status (checkout first)' })).toBeInTheDocument();
  fireEvent.click(within(statusFilters).getByRole('button', { name: /All rooms/ }));
  expect(screen.getAllByRole('article')).toHaveLength(6);
  expect(screen.getAllByRole('article').slice(0, 2).map(article => article.getAttribute('aria-label'))).toEqual(['Room 110, Waiting for checkout', 'Room 202, Waiting for checkout']);
});

test('the checkout queue includes unavailable departing guests and keeps unavailable continuing stays separate', async () => {
  const occupiedBlocked = { reportDate: '2026-10-03', housekeepingStatus: 'Dirty', occupancyStatus: 'Occupied', orderStatus: 'OOI/OI' };
  api.get.mockResolvedValue({ data: { data: [
    { ...occupiedBlocked, _id: 'blocked-due', roomNumber: '301', checkOut: '2026-10-03' },
    { ...occupiedBlocked, _id: 'blocked-stay', roomNumber: '302', checkOut: '2026-10-04' },
    { ...occupiedBlocked, _id: 'explicit-due', roomNumber: '303', checkOut: '2026-10-04', guestStatus: 'Due Out' }
  ] } });
  open(Dashboard, 'frontdesk');
  const due = await screen.findByRole('article', { name: 'Room 301, Waiting for checkout' });
  expect(within(due).getByText('Out of Order')).toBeInTheDocument();
  expect(within(due).getByRole('button', { name: 'Check out room 301' })).toBeEnabled();
  expect(screen.getByRole('article', { name: 'Room 303, Waiting for checkout' })).toBeInTheDocument();
  expect(screen.queryByRole('article', { name: /^Room 302,/ })).not.toBeInTheDocument();
  const statusFilters = screen.getByRole('group', { name: 'Filter rooms by status' });
  fireEvent.click(within(statusFilters).getByRole('button', { name: /Unavailable/ }));
  expect(screen.getByRole('article', { name: 'Room 302, Unavailable' })).toBeInTheDocument();
});

test.each(['frontdesk', 'admin'])('%s can select visible departures and check out two guests once', async role => {
  api.get.mockResolvedValue({ data: { data: deskRooms } });
  api.post.mockImplementation(url => {
    const room = deskRooms.find(record => url === `/room/${record._id}/checkout`);
    return Promise.resolve({ data: { data: { ...room, occupancyStatus: 'Vacant', housekeepingStatus: 'Dirty', guestStatus: 'Checked-out' } } });
  });
  open(Dashboard, role);
  await screen.findByRole('article', { name: 'Room 110, Waiting for checkout' });
  const initialReads = api.get.mock.calls.length;
  fireEvent.click(screen.getByRole('button', { name: 'Select rooms' }));
  const bulk = screen.getByRole('button', { name: 'Check out selected' });
  expect(bulk).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Select all visible rooms' }));
  expect(screen.getByRole('checkbox', { name: 'Select room 110' })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'Select room 202' })).toBeChecked();
  expect(screen.getByText('2 rooms selected')).toBeInTheDocument();
  expect(bulk).toBeEnabled();
  fireEvent.click(bulk);
  fireEvent.click(bulk);
  expect(await screen.findByText('2 rooms checked out. Housekeeping can now clean available rooms.')).toBeInTheDocument();
  expect(api.post).toHaveBeenCalledTimes(2);
  expect(api.post).toHaveBeenCalledWith('/room/desk-overdue/checkout');
  expect(api.post).toHaveBeenCalledWith('/room/desk-due/checkout');
  expect(screen.queryByRole('article')).not.toBeInTheDocument();
  fireEvent.click(within(screen.getByRole('group', { name: 'Filter rooms by status' })).getByRole('button', { name: /All rooms/ }));
  expect(screen.getByRole('article', { name: 'Room 110, Ready to clean' })).toBeInTheDocument();
  expect(screen.getByRole('article', { name: 'Room 202, Ready to clean' })).toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: 'Select room 110' })).toBeDisabled();
  expect(screen.getByRole('checkbox', { name: 'Select room 202' })).toBeDisabled();
  expect(screen.getByRole('checkbox', { name: 'Select room 110' })).not.toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'Select room 202' })).not.toBeChecked();
  expect(api.get).toHaveBeenCalledTimes(initialReads);
});

test('a partial bulk checkout keeps only the failed room selected and retries that guest', async () => {
  let currentRooms = deskRooms;
  let failDueRoom = true;
  api.get.mockImplementation(() => Promise.resolve({ data: { data: currentRooms } }));
  api.post.mockImplementation(url => {
    const room = currentRooms.find(record => url === `/room/${record._id}/checkout`);
    if (room._id === 'desk-due' && failDueRoom) {
      failDueRoom = false;
      return Promise.reject({ response: { data: { message: 'Guest extended the stay. Verify with the guest.' } } });
    }
    const updated = { ...room, occupancyStatus: 'Vacant', housekeepingStatus: 'Dirty', guestStatus: 'Checked-out' };
    currentRooms = currentRooms.map(record => record._id === room._id ? updated : record);
    return Promise.resolve({ data: { data: updated } });
  });
  open(Dashboard, 'frontdesk');
  await screen.findByRole('article', { name: 'Room 110, Waiting for checkout' });
  fireEvent.click(screen.getByRole('button', { name: 'Select rooms' }));
  fireEvent.click(screen.getByRole('button', { name: 'Select all visible rooms' }));
  fireEvent.click(screen.getByRole('button', { name: 'Check out selected' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('1 room checked out. 1 could not be checked out. Room 202: Guest extended the stay. Verify with the guest.');
  expect(screen.getByRole('checkbox', { name: 'Select room 202' })).toBeChecked();
  expect(screen.queryByRole('checkbox', { name: 'Select room 110' })).not.toBeInTheDocument();
  expect(screen.getByText('1 room selected')).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Check out selected' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Check out selected' }));
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(3));
  expect(api.post.mock.calls.filter(([url]) => url === '/room/desk-overdue/checkout')).toHaveLength(1);
  expect(api.post.mock.calls.filter(([url]) => url === '/room/desk-due/checkout')).toHaveLength(2);
  expect(api.post).toHaveBeenLastCalledWith('/room/desk-due/checkout');
  await waitFor(() => expect(screen.queryByRole('article', { name: 'Room 202, Waiting for checkout' })).not.toBeInTheDocument());
});

test('a late failed checkout does not restore a room already checked out by another staff member', async () => {
  const overdueCheckout = deferred();
  const dueCheckout = deferred();
  const refreshSnapshot = deferred();
  api.get.mockResolvedValueOnce({ data: { data: deskRooms } }).mockReturnValue(refreshSnapshot.promise);
  api.post.mockImplementation(url => url === '/room/desk-overdue/checkout' ? overdueCheckout.promise : dueCheckout.promise);
  open(Dashboard, 'frontdesk');
  await screen.findByRole('article', { name: 'Room 110, Waiting for checkout' });
  fireEvent.click(screen.getByRole('button', { name: 'Select rooms' }));
  fireEvent.click(screen.getByRole('button', { name: 'Select all visible rooms' }));
  fireEvent.click(screen.getByRole('button', { name: 'Check out selected' }));
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
  const due = { ...deskRooms.find(room => room._id === 'desk-due'), occupancyStatus: 'Vacant', guestStatus: 'Checked-out' };
  const { setRooms } = useRoomRealtime.mock.calls[useRoomRealtime.mock.calls.length - 1][0];
  act(() => setRooms(previous => previous.map(room => room._id === due._id ? due : room)));
  expect(screen.getByText('1 room selected')).toBeInTheDocument();
  expect(screen.queryByRole('article', { name: 'Room 202, Waiting for checkout' })).not.toBeInTheDocument();

  const overdue = { ...deskRooms.find(room => room._id === 'desk-overdue'), occupancyStatus: 'Vacant', guestStatus: 'Checked-out' };
  await act(async () => overdueCheckout.resolve({ data: { data: overdue } }));
  expect(screen.getByText('0 rooms selected')).toBeInTheDocument();
  await act(async () => dueCheckout.reject({ response: { data: { message: 'Another staff member already checked out this room.' } } }));
  expect(screen.getByRole('alert')).toHaveTextContent('Room 202: Another staff member already checked out this room.');
  expect(screen.getByText('0 rooms selected')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Check out selected' })).toBeDisabled();
  expect(screen.queryAllByRole('checkbox', { checked: true })).toHaveLength(0);
  expect(api.post).toHaveBeenCalledTimes(2);
  await act(async () => refreshSnapshot.resolve({ data: { data: deskRooms.map(room => room._id === due._id ? due : room._id === overdue._id ? overdue : room) } }));
});

test('keyboard focus returns to the room results after a focused individual checkout leaves the queue', async () => {
  api.get.mockResolvedValue({ data: { data: deskRooms } });
  const departing = deskRooms.find(room => room._id === 'desk-overdue');
  api.post.mockResolvedValue({ data: { data: { ...departing, occupancyStatus: 'Vacant', guestStatus: 'Checked-out' } } });
  open(Dashboard, 'frontdesk');
  const checkout = await screen.findByRole('button', { name: 'Check out room 110' });
  checkout.focus();
  expect(checkout).toHaveFocus();
  fireEvent.click(checkout);
  await waitFor(() => expect(screen.queryByRole('article', { name: 'Room 110, Waiting for checkout' })).not.toBeInTheDocument());
  expect(screen.getByRole('region', { name: 'Room board results' })).toHaveFocus();
  expect(screen.getByRole('article', { name: 'Room 202, Waiting for checkout' })).toBeInTheDocument();
});

test.each(['disabled checkout action', 'body', 'another control'])('bulk checkout preserves useful keyboard focus when focus is on %s', async focusLocation => {
  const pendingCheckout = deferred();
  api.get.mockResolvedValue({ data: { data: deskRooms } });
  api.post.mockImplementation(url => pendingCheckout.promise.then(() => {
    const room = deskRooms.find(record => url === `/room/${record._id}/checkout`);
    return { data: { data: { ...room, occupancyStatus: 'Vacant', guestStatus: 'Checked-out' } } };
  }));
  open(Dashboard, 'frontdesk');
  await screen.findByRole('article', { name: 'Room 110, Waiting for checkout' });
  fireEvent.click(screen.getByRole('button', { name: 'Select rooms' }));
  fireEvent.click(screen.getByRole('button', { name: 'Select all visible rooms' }));
  const checkout = screen.getByRole('button', { name: 'Check out selected' });
  checkout.focus();
  fireEvent.click(checkout);
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
  const table = within(screen.getByRole('group', { name: 'Room layout' })).getByRole('button', { name: 'Table' });
  if (focusLocation === 'body') {
    table.focus();
    table.blur();
    expect(document.body).toHaveFocus();
  } else if (focusLocation === 'another control') {
    table.focus();
    expect(table).toHaveFocus();
  } else {
    expect(checkout).toBeDisabled();
    expect(checkout).toHaveFocus();
  }
  await act(async () => pendingCheckout.resolve());
  expect(screen.getByText('2 rooms checked out. Housekeeping can now clean available rooms.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Check out selected' })).toBeDisabled();
  expect(screen.queryByRole('article')).not.toBeInTheDocument();
  if (focusLocation === 'another control') expect(table).toHaveFocus();
  else expect(screen.getByRole('group', { name: 'Selected room actions' })).toHaveFocus();
});

test('individual room selection survives a layout switch and can be cleared without checking out guests', async () => {
  api.get.mockResolvedValue({ data: { data: deskRooms } });
  open(Dashboard, 'frontdesk');
  await screen.findByRole('article', { name: 'Room 110, Waiting for checkout' });
  fireEvent.click(screen.getByRole('button', { name: 'Select rooms' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select room 110' }));
  expect(screen.getByText('1 room selected')).toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: 'Select room 202' })).not.toBeChecked();
  fireEvent.click(within(screen.getByRole('group', { name: 'Room layout' })).getByRole('button', { name: 'Table' }));
  expect(screen.getByRole('checkbox', { name: 'Select room 110' })).toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
  expect(screen.getByRole('checkbox', { name: 'Select room 110' })).not.toBeChecked();
  expect(screen.getByRole('button', { name: 'Check out selected' })).toBeDisabled();
  expect(api.post).not.toHaveBeenCalled();
});

test.each(['room search', 'workflow filter', 'occupancy filter', 'report date'])('changing %s clears the bulk selection scope', async scope => {
  api.get.mockResolvedValue({ data: { data: deskRooms } });
  open(Dashboard, 'frontdesk');
  await screen.findByRole('article', { name: 'Room 110, Waiting for checkout' });
  fireEvent.click(screen.getByRole('button', { name: 'Select rooms' }));
  fireEvent.click(screen.getByRole('button', { name: 'Select all visible rooms' }));
  expect(screen.getByText('2 rooms selected')).toBeInTheDocument();
  if (scope === 'room search') fireEvent.change(screen.getByRole('searchbox', { name: 'Find a room' }), { target: { value: '110' } });
  if (scope === 'workflow filter') fireEvent.click(within(screen.getByRole('group', { name: 'Filter rooms by status' })).getByRole('button', { name: /All rooms/ }));
  if (scope === 'occupancy filter') {
    fireEvent.click(screen.getByText('More filters and report tools'));
    fireEvent.change(screen.getByLabelText('Occupancy'), { target: { value: 'Occupied' } });
  }
  if (scope === 'report date') {
    fireEvent.click(screen.getByRole('button', { name: 'Next report date' }));
    await waitFor(() => expect(api.get).toHaveBeenLastCalledWith('/room/status/2026-10-04', expect.objectContaining({ params: { date: '2026-10-04' } })));
  }
  expect(screen.queryAllByRole('checkbox', { checked: true })).toHaveLength(0);
  expect(screen.getByRole('button', { name: 'Check out selected' })).toBeDisabled();
  expect(api.post).not.toHaveBeenCalled();
});

test('a live checkout removes that room from the bulk selection before any requests are sent', async () => {
  api.get.mockResolvedValue({ data: { data: deskRooms } });
  api.post.mockImplementation(url => {
    const room = deskRooms.find(record => url === `/room/${record._id}/checkout`);
    return Promise.resolve({ data: { data: { ...room, occupancyStatus: 'Vacant', housekeepingStatus: 'Dirty', guestStatus: 'Checked-out' } } });
  });
  open(Dashboard, 'frontdesk');
  await screen.findByRole('article', { name: 'Room 110, Waiting for checkout' });
  fireEvent.click(screen.getByRole('button', { name: 'Select rooms' }));
  fireEvent.click(screen.getByRole('button', { name: 'Select all visible rooms' }));
  const { setRooms } = useRoomRealtime.mock.calls[useRoomRealtime.mock.calls.length - 1][0];
  act(() => setRooms(previous => previous.map(room => room._id === 'desk-due' ? { ...room, occupancyStatus: 'Vacant', guestStatus: 'Checked-out' } : room)));
  expect(screen.queryByRole('checkbox', { name: 'Select room 202' })).not.toBeInTheDocument();
  expect(screen.getByText('1 room selected')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Check out selected' }));
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
  expect(api.post).toHaveBeenCalledWith('/room/desk-overdue/checkout');
});

test.each(['housekeeping', 'viewer'])('%s accounts have no individual or bulk guest checkout controls', async role => {
  api.get.mockResolvedValue({ data: { data: deskRooms } });
  open(Dashboard, role);
  await screen.findByRole('article', { name: 'Room 110, Waiting for checkout' });
  expect(screen.queryByRole('button', { name: 'Select rooms' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Check out selected' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Check out room/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('checkbox', { name: /Select room/ })).not.toBeInTheDocument();
  expect(api.post).not.toHaveBeenCalled();
});

test.each([
  ['known room version changes', true, { notes: 'Desk is reviewing a late checkout' }],
  ['a versioned guest extends their stay', true, { guestStatus: 'Stay Over', checkOut: '2026-10-04' }],
  ['an unversioned guest extends their stay', false, { guestStatus: 'Stay Over', checkOut: '2026-10-04' }]
])('a queued bulk checkout skips room 105 when %s and continues to room 106', async (description, versioned, changes) => {
  const initialVersion = '2026-10-03T12:00:01.000Z';
  const nextVersion = '2026-10-03T12:00:02.000Z';
  let serverRooms = Array.from({ length: 6 }, (_, index) => ({
    _id: `queued-${index}`, roomNumber: String(101 + index), reportDate: '2026-10-03',
    occupancyStatus: 'Occupied', housekeepingStatus: 'Dirty', guestStatus: 'Due Out', checkOut: '2026-10-03',
    ...(versioned ? { updatedAt: initialVersion } : {})
  }));
  const requests = serverRooms.map(() => deferred());
  const checkoutResponse = index => {
    const updated = { ...serverRooms[index], occupancyStatus: 'Vacant', guestStatus: 'Checked-out', ...(versioned ? { updatedAt: nextVersion } : {}) };
    serverRooms = serverRooms.map((room, position) => position === index ? updated : room);
    return { data: { data: updated } };
  };
  api.get.mockImplementation(() => Promise.resolve({ data: { data: serverRooms } }));
  api.post.mockImplementation(url => {
    const index = Number(url.match(/queued-(\d+)/)[1]);
    return index < 4 ? requests[index].promise : Promise.resolve(checkoutResponse(index));
  });
  open(Dashboard, 'frontdesk');
  await screen.findByRole('article', { name: 'Room 105, Waiting for checkout' });
  fireEvent.click(screen.getByRole('button', { name: 'Select rooms' }));
  fireEvent.click(screen.getByRole('button', { name: 'Select all visible rooms' }));
  fireEvent.click(screen.getByRole('button', { name: 'Check out selected' }));
  expect(api.post).toHaveBeenCalledTimes(4);

  serverRooms = serverRooms.map((room, index) => index === 4 ? { ...room, ...changes, ...(versioned ? { updatedAt: nextVersion } : {}) } : room);
  const { setRooms } = useRoomRealtime.mock.calls[useRoomRealtime.mock.calls.length - 1][0];
  act(() => setRooms(serverRooms));
  await act(async () => requests[0].resolve(checkoutResponse(0)));
  await waitFor(() => expect(api.post.mock.calls.some(([url]) => url === '/room/queued-5/checkout')).toBe(true));
  expect(api.post.mock.calls.some(([url]) => url === '/room/queued-4/checkout')).toBe(false);

  await act(async () => {
    for (const index of [3, 1, 2]) requests[index].resolve(checkoutResponse(index));
  });
  expect(await screen.findByRole('alert')).toHaveTextContent('5 rooms checked out. 1 could not be checked out. Room 105: The room changed.');
  expect(api.post).toHaveBeenCalledTimes(5);
  if (versioned) {
    for (const [url, body] of api.post.mock.calls) {
      expect(url).not.toBe('/room/queued-4/checkout');
      expect(body).toEqual({ expectedUpdatedAt: initialVersion });
    }
  } else {
    expect(api.post.mock.calls.every(call => call.length === 1)).toBe(true);
  }
});

test.each(['older full response', 'partial unversioned response'])('a late %s from checkout preserves the newer live guest stay', async responseShape => {
  const initial = { ...deskRooms[1], updatedAt: '2026-10-03T12:00:01.000Z' };
  const pendingCheckout = deferred();
  api.get.mockResolvedValue({ data: { data: [initial] } });
  api.post.mockReturnValue(pendingCheckout.promise);
  openAllDesk();
  fireEvent.click(await screen.findByRole('button', { name: 'Check out room 202' }));
  expect(api.post).toHaveBeenCalledWith('/room/desk-due/checkout', { expectedUpdatedAt: initial.updatedAt });
  const newest = { ...initial, guestStatus: 'Stay Over', checkOut: '2026-10-05', notes: 'Newest guest plan', updatedAt: '2026-10-03T12:00:03.000Z' };
  const { setRooms } = useRoomRealtime.mock.calls[useRoomRealtime.mock.calls.length - 1][0];
  act(() => setRooms([newest]));
  const older = responseShape === 'older full response'
    ? { ...initial, occupancyStatus: 'Vacant', guestStatus: 'Checked-out', updatedAt: '2026-10-03T12:00:02.000Z' }
    : { occupancyStatus: 'Vacant', guestStatus: 'Checked-out' };
  await act(async () => pendingCheckout.resolve({ data: { data: older } }));

  const currentRoom = screen.getByRole('article', { name: 'Room 202, Stayovers' });
  expect(within(currentRoom).getByText('Newest guest plan')).toBeInTheDocument();
  expect(within(currentRoom).getByText('Stayover · Service not done')).toBeInTheDocument();
  expect(within(currentRoom).getByRole('button', { name: 'Check out room 202' })).toBeEnabled();
  expect(screen.queryByRole('article', { name: 'Room 202, Ready to clean' })).not.toBeInTheDocument();
});

test.each(['older full response', 'partial unversioned response'])('a late %s from the room editor preserves newer live fields', async responseShape => {
  const initial = { ...rooms[0], updatedAt: '2026-10-03T12:00:01.000Z' };
  const pendingSave = deferred();
  api.get.mockResolvedValue({ data: { data: [initial] } });
  api.put.mockReturnValue(pendingSave.promise);
  openAllDesk();
  fireEvent.click(await screen.findByRole('button', { name: 'Edit room 101' }));
  const editor = screen.getByRole('form', { name: 'Edit room 101' });
  fireEvent.change(within(editor).getByLabelText('Notes'), { target: { value: 'Saved draft note' } });
  fireEvent.click(within(editor).getByRole('button', { name: 'Save' }));
  const newest = { ...initial, housekeepingStatus: 'Clean', notes: 'Newest desk note', updatedAt: '2026-10-03T12:00:03.000Z' };
  const { setRooms } = useRoomRealtime.mock.calls[useRoomRealtime.mock.calls.length - 1][0];
  act(() => setRooms([newest]));
  const older = responseShape === 'older full response'
    ? { ...initial, notes: 'Saved draft note', updatedAt: '2026-10-03T12:00:02.000Z' }
    : { notes: 'Saved draft note', housekeepingStatus: 'Dirty' };
  await act(async () => pendingSave.resolve({ data: { data: older } }));

  const currentRoom = screen.getByRole('article', { name: 'Room 101, Done' });
  expect(within(currentRoom).getByText('Newest desk note')).toBeInTheDocument();
  expect(screen.queryByRole('form', { name: 'Edit room 101' })).not.toBeInTheDocument();
  expect(screen.queryByText('Saved draft note')).not.toBeInTheDocument();
});
