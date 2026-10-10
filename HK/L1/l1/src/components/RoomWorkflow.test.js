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

function open(Component, role = 'housekeeping') {
  return render(<MemoryRouter initialEntries={['/?date=2026-10-03']}><AuthContext.Provider value={{ user: { role }, token: 'test-session' }}><Component /></AuthContext.Provider></MemoryRouter>);
}

beforeEach(() => {
  jest.resetAllMocks();
  localStorage.clear();
  api.get.mockResolvedValue({ data: { data: rooms } });
  useRoomRealtime.mockReturnValue(true);
});

test('only a vacant dirty room has a one-tap completion button; completion can be undone', async () => {
  api.put.mockImplementation((url, changes) => Promise.resolve({ data: { data: { ...rooms[0], ...changes } } }));
  open(HouseKeeping);
  const ready = await screen.findByRole('article', { name: 'Room 101, Ready to clean' });
  expect(within(ready).getByRole('button', { name: 'Mark room 101 done' })).toBeEnabled();
  expect(within(screen.getByRole('article', { name: 'Room 102, Waiting for checkout' })).queryByRole('button')).not.toBeInTheDocument();
  expect(within(screen.getByRole('article', { name: 'Room 103, Done' })).queryByRole('button')).not.toBeInTheDocument();
  expect(within(screen.getByRole('article', { name: 'Room 104, Unavailable' })).queryByRole('button')).not.toBeInTheDocument();
  fireEvent.click(within(ready).getByRole('button'));
  await screen.findByRole('article', { name: 'Room 101, Done' });
  expect(api.put).toHaveBeenCalledWith('/housekeeper/ready', { housekeepingStatus: 'Clean' });
  fireEvent.click(screen.getByRole('button', { name: 'Undo room 101' }));
  await screen.findByRole('article', { name: 'Room 101, Ready to clean' });
  expect(api.put).toHaveBeenLastCalledWith('/housekeeper/ready', { housekeepingStatus: 'Dirty' });
});

test('failed completion keeps the room ready and explains that it was not saved', async () => {
  api.put.mockRejectedValue({ response: { data: { message: 'The room is now occupied. Refresh before cleaning.' } } });
  open(HouseKeeping);
  fireEvent.click(await screen.findByRole('button', { name: 'Mark room 101 done' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('The room is now occupied');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Mark room 101 done' })).toBeEnabled());
  expect(screen.queryByRole('article', { name: 'Room 101, Done' })).not.toBeInTheDocument();
});

test('front desk checks out a guest directly and the room becomes ready to clean', async () => {
  api.post.mockResolvedValue({ data: { data: { ...rooms[1], occupancyStatus: 'Vacant', housekeepingStatus: 'Dirty', guestStatus: 'Checked-out' } } });
  open(Dashboard, 'frontdesk');
  fireEvent.click(await screen.findByRole('button', { name: 'Check out room 102' }));
  expect(api.post).toHaveBeenCalledWith('/room/waiting/checkout');
  await screen.findByRole('article', { name: 'Room 102, Ready to clean' });
  expect(screen.queryByRole('button', { name: 'Check out room 102' })).not.toBeInTheDocument();
  expect(screen.getByText('Room 102 checked out. Housekeeping can now clean it.')).toBeInTheDocument();
});

test('front desk housekeeping view is read-only and a housekeeping account cannot check out guests', async () => {
  const view = open(HouseKeeping, 'frontdesk');
  await screen.findByRole('article', { name: 'Room 101, Ready to clean' });
  expect(screen.queryByRole('button', { name: /Mark room/ })).not.toBeInTheDocument();
  view.unmount();
  open(Dashboard, 'housekeeping');
  await screen.findByRole('article', { name: 'Room 102, Waiting for checkout' });
  expect(screen.queryByRole('button', { name: /Check out room/ })).not.toBeInTheDocument();
});

test('housekeeping combines workflow, room search, and attendant filters and can clear an empty result', async () => {
  open(HouseKeeping);
  const ready = await screen.findByRole('article', { name: 'Room 101, Ready to clean' });
  expect(within(ready).getByText('Extra towels')).toBeInTheDocument();
  expect(within(ready).getByText('Pet in room')).toBeInTheDocument();
  const unavailable = screen.getByRole('article', { name: 'Room 104, Unavailable' });
  expect(within(unavailable).getByText('Air conditioning repair')).toBeInTheDocument();
  expect(within(unavailable).getByText('Wait for maintenance release')).toBeInTheDocument();

  fireEvent.click(within(screen.getByRole('group', { name: 'Filter rooms by status' })).getByRole('button', { name: /Ready to clean/ }));
  fireEvent.change(screen.getByRole('searchbox', { name: 'Find a room' }), { target: { value: '10' } });
  fireEvent.click(screen.getByText(/More filters and report date/));
  fireEvent.change(screen.getByLabelText('Assigned attendant'), { target: { value: 'Maria' } });
  expect(screen.getAllByRole('article')).toHaveLength(1);
  expect(screen.getByRole('article')).toHaveAccessibleName('Room 101, Ready to clean');
  fireEvent.change(screen.getByLabelText('Assigned attendant'), { target: { value: 'Ana' } });
  expect(screen.queryByRole('article')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Show all rooms' }));
  expect(screen.getAllByRole('article')).toHaveLength(4);
  expect(screen.getByRole('searchbox', { name: 'Find a room' })).toHaveValue('');
  expect(screen.getByLabelText('Assigned attendant')).toHaveValue('all');
});

test.each([
  ['housekeeping', HouseKeeping, '/housekeeper'],
  ['frontdesk', Dashboard, '/room/status/2026-10-04']
])('%s loads only the newly selected report date', async (role, Component, endpoint) => {
  api.get.mockImplementation((url, config) => Promise.resolve({ data: { data: config.params.date === '2026-10-03' ? rooms : [] } }));
  open(Component, role);
  await screen.findByRole('article', { name: 'Room 101, Ready to clean' });
  if (role === 'housekeeping') fireEvent.click(screen.getByText(/More filters and report date/));
  fireEvent.click(screen.getByRole('button', { name: 'Next report date' }));
  await waitFor(() => expect(api.get).toHaveBeenLastCalledWith(endpoint, expect.objectContaining({ params: { date: '2026-10-04' } })));
  expect(await screen.findByRole('heading', { name: /No (rooms|room report) for 2026-10-04/ })).toBeInTheDocument();
  expect(screen.queryByRole('article')).not.toBeInTheDocument();
});

test('front desk combines room search, occupancy, pet, and stay-date filters', async () => {
  open(Dashboard, 'frontdesk');
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
  open(Dashboard, 'frontdesk');
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
  open(Dashboard, 'frontdesk');
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
  open(Dashboard, 'frontdesk');
  fireEvent.click(await screen.findByRole('button', { name: 'Edit room 101' }));
  const editor = screen.getByRole('form', { name: 'Edit room 101' });
  within(editor).getByLabelText('Notes').focus();
  fireEvent.click(within(editor).getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('form', { name: 'Edit room 101' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Edit room 101' })).toHaveFocus();
  expect(api.put).not.toHaveBeenCalled();
});

test('front desk rejects a check-out before check-in without discarding the edit', async () => {
  open(Dashboard, 'frontdesk');
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
  open(Dashboard, 'frontdesk');
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

test('a housekeeping account can edit waiting-room notes but cannot change guest details or cleaning status', async () => {
  api.put.mockImplementation((url, changes) => Promise.resolve({ data: { data: { ...rooms[1], ...changes } } }));
  open(Dashboard, 'housekeeping');
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

test('front desk defaults to Table and remembers the selected layout without refreshing rooms', async () => {
  const view = open(Dashboard, 'frontdesk');
  await screen.findByRole('article', { name: 'Room 101, Ready to clean' });
  const layout = screen.getByRole('group', { name: 'Room layout' });
  expect(within(layout).getByRole('button', { name: 'Table' })).toHaveAttribute('aria-pressed', 'true');
  expect(within(layout).getByRole('button', { name: 'Boxes' })).toHaveAttribute('aria-pressed', 'false');
  const initialReads = api.get.mock.calls.length;
  fireEvent.click(within(layout).getByRole('button', { name: 'Boxes' }));
  expect(within(layout).getByRole('button', { name: 'Boxes' })).toHaveAttribute('aria-pressed', 'true');
  expect(within(layout).getByRole('button', { name: 'Table' })).toHaveAttribute('aria-pressed', 'false');
  expect(localStorage.getItem('motel.frontdesk.layout.v1')).toBe('boxes');
  expect(api.get).toHaveBeenCalledTimes(initialReads);

  view.unmount();
  const { unmount } = open(Dashboard, 'frontdesk');
  await screen.findByRole('article', { name: 'Room 101, Ready to clean' });
  const restoredLayout = screen.getByRole('group', { name: 'Room layout' });
  expect(within(restoredLayout).getByRole('button', { name: 'Boxes' })).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(within(restoredLayout).getByRole('button', { name: 'Table' }));
  expect(localStorage.getItem('motel.frontdesk.layout.v1')).toBe('table');
  unmount();
  open(Dashboard, 'frontdesk');
  await screen.findByRole('article', { name: 'Room 101, Ready to clean' });
  expect(within(screen.getByRole('group', { name: 'Room layout' })).getByRole('button', { name: 'Table' })).toHaveAttribute('aria-pressed', 'true');
});

test('switching layouts preserves search, filters, the open draft, and live room changes', async () => {
  api.put.mockImplementation((url, changes) => Promise.resolve({ data: { data: { ...rooms[0], housekeepingStatus: 'Clean', ...changes } } }));
  open(Dashboard, 'frontdesk');
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
  open(Dashboard, 'frontdesk');
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
