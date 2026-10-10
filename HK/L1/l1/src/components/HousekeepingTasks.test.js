import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext } from '../context/authContext';
import api from '../api';
import useRoomRealtime from '../hooks/useRoomRealtime';
import { localDate } from '../utils/roomData';
import HouseKeeping from './houseKeeping';

jest.mock('../api', () => ({ __esModule: true, default: { get: jest.fn(), put: jest.fn() } }));
jest.mock('../hooks/useRoomRealtime', () => ({ __esModule: true, default: jest.fn() }));

const reportDate = '2026-10-03';
const taskRooms = [
  { _id: 'checkout', roomNumber: '101', reportDate, housekeepingStatus: 'Dirty', occupancyStatus: 'Vacant', guestStatus: 'Checked-out', checkedOutAt: '2026-10-03T15:00:00.000Z', checkOut: reportDate, notes: 'Extra towels', pet: true },
  { _id: 'stayover', roomNumber: '102', reportDate, housekeepingStatus: 'Dirty', occupancyStatus: 'Occupied', checkOut: '2026-10-04', assignedAttendant: 'Maria', notes: 'Guest requests afternoon service', issues: ['Replace coffee', 'Guest requests afternoon service'] },
  { _id: 'due', roomNumber: '103', reportDate, housekeepingStatus: 'Dirty', occupancyStatus: 'Occupied', guestStatus: 'Due Out', checkOut: reportDate },
  { _id: 'unknown', roomNumber: '104', reportDate, housekeepingStatus: 'Dirty', occupancyStatus: 'Occupied', checkOut: 'Unknown' },
  { _id: 'done', roomNumber: '105', reportDate, housekeepingStatus: 'Clean', occupancyStatus: 'Vacant' },
  { _id: 'blocked', roomNumber: '106', reportDate, housekeepingStatus: 'Clean', occupancyStatus: 'Vacant', orderStatus: 'OOI/OI', reason: 'Air conditioning repair', description: 'Wait for maintenance release' },
  { _id: 'vacant', roomNumber: '107', reportDate, housekeepingStatus: 'Dirty', occupancyStatus: 'Vacant' },
  { _id: 'serviced', roomNumber: '108', reportDate, housekeepingStatus: 'Dirty', occupancyStatus: 'Occupied', checkOut: '2026-10-05', assignedAttendant: 'Maria', stayoverServicedAt: '2026-10-03T15:30:00.000Z' }
];

function open(role = 'housekeeping') {
  return render(<MemoryRouter initialEntries={[`/?date=${reportDate}`]}><AuthContext.Provider value={{ user: { role }, token: 'test-session' }}><HouseKeeping /></AuthContext.Provider></MemoryRouter>);
}

function latestRoomSetter() {
  return useRoomRealtime.mock.calls[useRoomRealtime.mock.calls.length - 1][0].setRooms;
}

const listItem = name => screen.getByRole('listitem', { name });
const tab = name => screen.getByRole('tab', { name: new RegExp(`^${name} \\d+$`) });
function selectTab(name) {
  fireEvent.click(tab(name));
  return screen.getByRole('tabpanel', { name: new RegExp(`^${name} \\d+$`) });
}

beforeEach(() => {
  jest.resetAllMocks();
  api.get.mockResolvedValue({ data: { data: taskRooms } });
  useRoomRealtime.mockReturnValue(true);
});

test('opens on ready cleaning only, and tabs preserve the colored room boxes for each task', async () => {
  open();
  await screen.findByRole('listitem', { name: 'Room 101, Dirty' });
  expect(screen.getByRole('tablist', { name: 'Room tasks' })).toBeInTheDocument();
  for (const [name, count] of [['Ready to clean', 2], ['Services', 2], ['Waiting for checkout', 2], ['Done', 2], ['Unavailable', 1]]) {
    expect(tab(name)).toHaveAccessibleName(`${name} ${count}`);
    expect(tab(name)).toHaveAttribute('aria-selected', name === 'Ready to clean' ? 'true' : 'false');
  }
  const ready = screen.getByRole('tabpanel', { name: 'Ready to clean 2' });
  expect(within(ready).getByRole('listitem', { name: 'Room 101, Dirty' }).firstChild).toHaveClass('hk-box', 'hk-tone-ready');
  expect(within(ready).getByRole('listitem', { name: 'Room 107, Dirty' }).firstChild).toHaveClass('hk-tone-ready');
  for (const number of ['102', '103', '104', '105', '106', '108']) {
    expect(screen.queryByRole('listitem', { name: new RegExp(`^Room ${number},`) })).not.toBeInTheDocument();
  }

  const initialReads = api.get.mock.calls.length;
  const services = selectTab('Services');
  const stayover = within(services).getByRole('listitem', { name: 'Room 102, Service not done' });
  expect(stayover.firstChild).toHaveClass('hk-tone-stayover');
  expect(within(stayover).getByRole('button', { name: 'Mark room 102 service done' })).toBeEnabled();
  expect(within(services).getByRole('listitem', { name: 'Room 108, Service done' }).firstChild).toHaveClass('hk-tone-done');
  expect(within(services).getByRole('button', { name: 'Revert room 108 service' })).toBeEnabled();
  expect(screen.queryByRole('listitem', { name: /^Room 101,/ })).not.toBeInTheDocument();

  const waiting = selectTab('Waiting for checkout');
  for (const name of ['Room 103, Checkout', 'Room 104, Occupied']) {
    const room = within(waiting).getByRole('listitem', { name });
    expect(room.firstChild).toHaveClass('hk-tone-waiting');
    expect(within(room).queryByRole('button')).not.toBeInTheDocument();
  }
  const done = selectTab('Done');
  expect(within(done).getByRole('listitem', { name: 'Room 105, Clean' }).firstChild).toHaveClass('hk-tone-done');
  expect(within(done).getByRole('listitem', { name: 'Room 108, Service done' })).toBeInTheDocument();
  const blocked = within(selectTab('Unavailable')).getByRole('listitem', { name: 'Room 106, Out of Order' });
  expect(blocked.firstChild).toHaveClass('hk-tone-unavailable');
  expect(within(blocked).queryByRole('button')).not.toBeInTheDocument();
  expect(api.get).toHaveBeenCalledTimes(initialReads);
});

test('keeps room notes and pet flags with the room in its selected tab', async () => {
  open();
  const checkoutNotes = await screen.findByRole('listitem', { name: 'Notes for room 101' });
  expect(within(checkoutNotes).getByText('Extra towels')).toBeInTheDocument();
  expect(within(checkoutNotes).getByText('Pet in room')).toBeInTheDocument();
  expect(screen.queryByRole('listitem', { name: 'Notes for room 102' })).not.toBeInTheDocument();
  const stayoverNotes = within(selectTab('Services')).getByRole('listitem', { name: 'Notes for room 102' });
  expect(within(stayoverNotes).getAllByText('Guest requests afternoon service')).toHaveLength(1);
  expect(within(stayoverNotes).getByText('Replace coffee')).toBeInTheDocument();
  const blockedNotes = within(selectTab('Unavailable')).getByRole('listitem', { name: 'Notes for room 106' });
  expect(within(blockedNotes).getByText('Air conditioning repair')).toBeInTheDocument();
  expect(within(blockedNotes).getByText('Wait for maintenance release')).toBeInTheDocument();
});

test('keyboard navigation selects the focused task tab and wraps from the end', async () => {
  open();
  await screen.findByRole('listitem', { name: 'Room 101, Dirty' });
  tab('Ready to clean').focus();
  fireEvent.keyDown(tab('Ready to clean'), { key: 'ArrowRight' });
  expect(tab('Services')).toHaveFocus();
  expect(tab('Services')).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('tabpanel', { name: 'Services 2' })).toBeInTheDocument();
  fireEvent.keyDown(tab('Services'), { key: 'End' });
  expect(tab('Unavailable')).toHaveFocus();
  expect(tab('Unavailable')).toHaveAttribute('aria-selected', 'true');
  fireEvent.keyDown(tab('Unavailable'), { key: 'ArrowRight' });
  expect(tab('Ready to clean')).toHaveFocus();
  expect(tab('Ready to clean')).toHaveAttribute('aria-selected', 'true');
  fireEvent.keyDown(tab('Ready to clean'), { key: 'ArrowLeft' });
  expect(tab('Unavailable')).toHaveFocus();
  fireEvent.keyDown(tab('Unavailable'), { key: 'Home' });
  expect(tab('Ready to clean')).toHaveFocus();
  expect(tab('Ready to clean')).toHaveAttribute('tabindex', '0');
  expect(tab('Services')).toHaveAttribute('tabindex', '-1');
});

test('stayover completion stays in Services, records only service, and supports Undo', async () => {
  api.put.mockImplementation((url, changes) => Promise.resolve({ data: { data: changes } }));
  open();
  await screen.findByRole('listitem', { name: 'Room 101, Dirty' });
  selectTab('Services');
  fireEvent.click(screen.getByRole('button', { name: 'Mark room 102 service done' }));
  const serviced = await screen.findByRole('listitem', { name: 'Room 102, Service done' });
  expect(serviced.firstChild).toHaveClass('hk-tone-done');
  expect(within(serviced).getByRole('button', { name: 'Revert room 102 service' })).toBeEnabled();
  expect(tab('Services')).toHaveAttribute('aria-selected', 'true');
  expect(tab('Services')).toHaveAccessibleName('Services 2');
  expect(tab('Done')).toHaveAccessibleName('Done 3');
  expect(api.put).toHaveBeenCalledTimes(1);
  const [endpoint, changes] = api.put.mock.calls[0];
  expect(endpoint).toBe('/housekeeper/stayover');
  expect(Object.keys(changes)).toEqual(['stayoverServicedAt']);
  expect(new Date(changes.stayoverServicedAt).toISOString()).toBe(changes.stayoverServicedAt);
  expect(screen.getByText('Room 102 service is done. Front desk can see it now.')).toBeInTheDocument();
  let savedRoom;
  act(() => latestRoomSetter()(current => { savedRoom = current.find(room => room._id === 'stayover'); return current; }));
  expect(savedRoom).toEqual(expect.objectContaining({ occupancyStatus: 'Occupied', housekeepingStatus: 'Dirty', stayoverServicedAt: changes.stayoverServicedAt }));

  fireEvent.click(screen.getByRole('button', { name: 'Undo room 102' }));
  await screen.findByRole('listitem', { name: 'Room 102, Service not done' });
  expect(api.put).toHaveBeenLastCalledWith('/housekeeper/stayover', { stayoverServicedAt: null });
  expect(screen.getByText('Room 102 service is marked not done.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Mark room 102 service done' })).toBeEnabled();
  expect(screen.queryByRole('button', { name: 'Undo room 102' })).not.toBeInTheDocument();
});

test('a preexisting clean room can be reverted from Done without a recent-action toast', async () => {
  api.put.mockImplementation((url, changes) => Promise.resolve({ data: { data: changes } }));
  open();
  await screen.findByRole('listitem', { name: 'Room 101, Dirty' });
  selectTab('Done');
  expect(screen.queryByRole('button', { name: 'Undo room 105' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Revert room 105 cleaning' }));
  await waitFor(() => expect(screen.queryByRole('listitem', { name: 'Room 105, Clean' })).not.toBeInTheDocument());
  expect(api.put).toHaveBeenCalledWith('/housekeeper/done', { housekeepingStatus: 'Dirty' });
  expect(tab('Done')).toHaveAttribute('aria-selected', 'true');
  expect(tab('Done')).toHaveAccessibleName('Done 1');
  expect(tab('Ready to clean')).toHaveAccessibleName('Ready to clean 3');
  expect(screen.getByText('Room 105 is marked dirty again.')).toBeInTheDocument();
  expect(within(selectTab('Ready to clean')).getByRole('button', { name: 'Mark room 105 clean' })).toBeEnabled();
});

test.each(['Services', 'Done'])('a previously serviced stayover can be reverted from %s without changing the guest or cleaning status', async selectedTab => {
  api.put.mockImplementation((url, changes) => Promise.resolve({ data: { data: changes } }));
  open();
  await screen.findByRole('listitem', { name: 'Room 101, Dirty' });
  selectTab(selectedTab);
  fireEvent.click(screen.getByRole('button', { name: 'Revert room 108 service' }));
  await waitFor(() => expect(api.put).toHaveBeenCalledWith('/housekeeper/serviced', { stayoverServicedAt: null }));
  await screen.findByText('Room 108 service is marked not done.');
  expect(tab(selectedTab)).toHaveAttribute('aria-selected', 'true');
  expect(tab('Services')).toHaveAccessibleName('Services 2');
  expect(tab('Done')).toHaveAccessibleName('Done 1');
  let savedRoom;
  act(() => latestRoomSetter()(current => { savedRoom = current.find(room => room._id === 'serviced'); return current; }));
  expect(savedRoom).toEqual(expect.objectContaining({ occupancyStatus: 'Occupied', housekeepingStatus: 'Dirty', stayoverServicedAt: null }));
  if (selectedTab === 'Done') {
    expect(screen.queryByRole('listitem', { name: /^Room 108,/ })).not.toBeInTheDocument();
    selectTab('Services');
  }
  expect(listItem('Room 108, Service not done').firstChild).toHaveClass('hk-tone-stayover');
});

test('front desk can browse every tab but cannot complete or revert housekeeping work', async () => {
  open('frontdesk');
  await screen.findByRole('listitem', { name: 'Room 101, Dirty' });
  for (const name of ['Ready to clean', 'Services', 'Waiting for checkout', 'Done', 'Unavailable']) {
    selectTab(name);
    expect(screen.queryByRole('button', { name: /^(Mark|Revert|Undo) room/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Select rooms' })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  }
  expect(api.put).not.toHaveBeenCalled();
});

test('selection uses room checkboxes and marks only selected ready rooms clean together', async () => {
  api.put.mockImplementation((url, changes) => Promise.resolve({ data: { data: changes } }));
  open();
  await screen.findByRole('listitem', { name: 'Room 101, Dirty' });
  fireEvent.click(screen.getByRole('button', { name: 'Select rooms' }));
  expect(screen.getByRole('button', { name: 'Select rooms' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.queryByRole('button', { name: /^Mark room/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select room 101' }));
  expect(listItem('Room 101, Dirty')).toHaveClass('is-selected');
  expect(screen.getByRole('checkbox', { name: 'Select room 107' })).not.toBeChecked();
  expect(screen.getByRole('region', { name: 'Selected rooms' })).toHaveTextContent('1 selected');
  expect(api.put).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Select all visible rooms' }));
  expect(screen.getAllByRole('checkbox').every(checkbox => checkbox.checked)).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Mark selected rooms clean' }));

  await screen.findByText('2 rooms marked clean.');
  expect(api.put).toHaveBeenCalledTimes(2);
  expect(api.put).toHaveBeenCalledWith('/housekeeper/checkout', { housekeepingStatus: 'Clean' });
  expect(api.put).toHaveBeenCalledWith('/housekeeper/vacant', { housekeepingStatus: 'Clean' });
  expect(screen.getByRole('heading', { name: 'No rooms ready to clean' })).toBeInTheDocument();
  expect(tab('Done')).toHaveAccessibleName('Done 4');
  expect(screen.getByRole('region', { name: 'Selected rooms' })).toHaveTextContent('0 selected');
});

test('Services bulk actions complete selected pending services and revert selected completed services separately', async () => {
  api.put.mockImplementation((url, changes) => Promise.resolve({ data: { data: changes } }));
  open();
  await screen.findByRole('listitem', { name: 'Room 101, Dirty' });
  selectTab('Services');
  fireEvent.click(screen.getByRole('button', { name: 'Select rooms' }));
  fireEvent.click(screen.getByRole('button', { name: 'Select all visible rooms' }));
  expect(screen.getByRole('region', { name: 'Selected rooms' })).toHaveTextContent('2 selected');
  fireEvent.click(screen.getByRole('button', { name: 'Mark selected services done' }));

  await screen.findByText('1 stayover service marked done.');
  expect(api.put).toHaveBeenCalledTimes(1);
  expect(api.put).toHaveBeenCalledWith('/housekeeper/stayover', { stayoverServicedAt: expect.any(String) });
  expect(Object.keys(api.put.mock.calls[0][1])).toEqual(['stayoverServicedAt']);
  expect(listItem('Room 102, Service done').firstChild).toHaveClass('hk-tone-done');
  expect(screen.getByRole('checkbox', { name: 'Select room 102' })).not.toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'Select room 108' })).toBeChecked();
  expect(screen.getByRole('button', { name: 'Mark selected services done' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Revert selected rooms' }));
  await screen.findByText('1 room reverted.');
  expect(api.put).toHaveBeenLastCalledWith('/housekeeper/serviced', { stayoverServicedAt: null });
  expect(listItem('Room 108, Service not done').firstChild).toHaveClass('hk-tone-stayover');
  expect(tab('Services')).toHaveAttribute('aria-selected', 'true');
});

test('Done can revert clean rooms and serviced stayovers in one selected action', async () => {
  api.put.mockImplementation((url, changes) => Promise.resolve({ data: { data: changes } }));
  open();
  await screen.findByRole('listitem', { name: 'Room 101, Dirty' });
  selectTab('Done');
  fireEvent.click(screen.getByRole('button', { name: 'Select rooms' }));
  fireEvent.click(screen.getByRole('button', { name: 'Select all visible rooms' }));
  fireEvent.click(screen.getByRole('button', { name: 'Revert selected rooms' }));
  await screen.findByText('2 rooms reverted.');
  expect(api.put).toHaveBeenCalledWith('/housekeeper/done', { housekeepingStatus: 'Dirty' });
  expect(api.put).toHaveBeenCalledWith('/housekeeper/serviced', { stayoverServicedAt: null });
  expect(screen.getByRole('heading', { name: 'No completed rooms yet' })).toBeInTheDocument();
  expect(tab('Ready to clean')).toHaveAccessibleName('Ready to clean 3');
  expect(tab('Services')).toHaveAccessibleName('Services 2');
});

test('partial bulk failure saves successful rooms, preserves warnings, and leaves only failed targets selected for retry', async () => {
  const savedSnapshot = taskRooms.map(room => room._id === 'checkout' ? { ...room, housekeepingStatus: 'Clean' } : room);
  api.get.mockResolvedValueOnce({ data: { data: taskRooms } }).mockResolvedValue({ data: { data: savedSnapshot } });
  api.put.mockImplementation((url, changes) => url === '/housekeeper/checkout'
    ? Promise.resolve({ data: { data: changes, warning: 'Live updates are temporarily unavailable.' } })
    : Promise.reject({ response: { data: { message: 'The room is now occupied.' } } }));
  open();
  await screen.findByRole('listitem', { name: 'Room 101, Dirty' });
  fireEvent.click(screen.getByRole('button', { name: 'Select rooms' }));
  fireEvent.click(screen.getByRole('button', { name: 'Select all visible rooms' }));
  fireEvent.click(screen.getByRole('button', { name: 'Mark selected rooms clean' }));
  await screen.findByText('1 room marked clean. 1 room could not be saved. Eligible rooms remain selected for retry. 1 room saved; front desk sync needs retry.');
  await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
  expect(screen.getByRole('alert')).toHaveTextContent('Room 101: Live updates are temporarily unavailable.');
  expect(screen.getByRole('alert')).toHaveTextContent('Room 107: The room is now occupied.');
  expect(screen.queryByRole('listitem', { name: /^Room 101,/ })).not.toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: 'Select room 107' })).toBeChecked();
  expect(screen.getByRole('region', { name: 'Selected rooms' })).toHaveTextContent('1 selected');
  expect(tab('Ready to clean')).toHaveAccessibleName('Ready to clean 1');
  expect(screen.queryByText(/2 rooms marked clean/)).not.toBeInTheDocument();

  api.put.mockImplementation((url, changes) => Promise.resolve({ data: { data: changes } }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Mark selected rooms clean' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Mark selected rooms clean' }));
  await screen.findByText('1 room marked clean.');
  expect(api.put).toHaveBeenCalledTimes(3);
  expect(api.put).toHaveBeenLastCalledWith('/housekeeper/vacant', { housekeepingStatus: 'Clean' });
  expect(screen.getByRole('alert')).toHaveTextContent('Room 101: Live updates are temporarily unavailable.');
  expect(screen.getByRole('alert')).not.toHaveTextContent('Room 107: The room is now occupied.');
});

test('a failed bulk save refreshes once, prunes stale occupied targets, and retains eligible failed rooms', async () => {
  const anotherReady = { _id: 'retry', roomNumber: '109', reportDate, housekeepingStatus: 'Dirty', occupancyStatus: 'Vacant' };
  const initialRooms = [...taskRooms, anotherReady];
  const freshRooms = initialRooms.map(room => room._id === 'checkout'
    ? { ...room, housekeepingStatus: 'Clean' }
    : room._id === 'vacant' ? { ...room, occupancyStatus: 'Occupied' } : room);
  api.get.mockResolvedValueOnce({ data: { data: initialRooms } }).mockResolvedValue({ data: { data: freshRooms } });
  api.put.mockImplementation((url, changes) => url === '/housekeeper/checkout'
    ? Promise.resolve({ data: { data: changes } })
    : Promise.reject({ response: { data: { message: 'The room changed. Please review it.' } } }));
  open();
  await screen.findByRole('listitem', { name: 'Room 101, Dirty' });
  fireEvent.click(screen.getByRole('button', { name: 'Select rooms' }));
  fireEvent.click(screen.getByRole('button', { name: 'Select all visible rooms' }));
  fireEvent.click(screen.getByRole('button', { name: 'Mark selected rooms clean' }));

  await waitFor(() => expect(tab('Ready to clean')).toHaveAccessibleName('Ready to clean 1'));
  expect(api.get).toHaveBeenCalledTimes(2);
  expect(api.put).toHaveBeenCalledTimes(3);
  expect(screen.queryByRole('checkbox', { name: 'Select room 107' })).not.toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: 'Select room 109' })).toBeChecked();
  expect(screen.getByRole('region', { name: 'Selected rooms' })).toHaveTextContent('1 selected');
  expect(screen.getByRole('alert')).toHaveTextContent('Room 107: The room changed. Please review it.');
  expect(screen.getByRole('alert')).toHaveTextContent('Room 109: The room changed. Please review it.');
});

test('a fifth queued room changed by a live checkout cycle is rejected before its bulk PUT starts', async () => {
  const version = '2026-10-03T10:00:00.000Z';
  const initialRooms = Array.from({ length: 5 }, (_, index) => ({ _id: `queued-${index}`, roomNumber: String(201 + index), reportDate, housekeepingStatus: 'Dirty', occupancyStatus: 'Vacant', checkedOutAt: version, updatedAt: version }));
  const changedRoom = { ...initialRooms[4], checkedOutAt: '2026-10-03T12:00:00.000Z', updatedAt: '2026-10-03T12:00:00.000Z' };
  const freshRooms = initialRooms.map((room, index) => index === 4 ? changedRoom : { ...room, housekeepingStatus: 'Clean', updatedAt: '2026-10-03T11:00:00.000Z' });
  api.get.mockResolvedValueOnce({ data: { data: initialRooms } }).mockResolvedValue({ data: { data: freshRooms } });
  const finishes = [];
  api.put.mockImplementation((url, changes) => new Promise(resolve => {
    const source = initialRooms.find(room => url === `/housekeeper/${room._id}`);
    finishes.push(() => resolve({ data: { data: { ...source, housekeepingStatus: 'Clean', updatedAt: '2026-10-03T11:00:00.000Z' } } }));
  }));
  open();
  await screen.findByRole('listitem', { name: 'Room 201, Dirty' });
  fireEvent.click(screen.getByRole('button', { name: 'Select rooms' }));
  fireEvent.click(screen.getByRole('button', { name: 'Select all visible rooms' }));
  fireEvent.click(screen.getByRole('button', { name: 'Mark selected rooms clean' }));
  expect(api.put).toHaveBeenCalledTimes(4);
  expect(api.put).toHaveBeenCalledWith('/housekeeper/queued-0', { housekeepingStatus: 'Clean', expectedUpdatedAt: version });
  act(() => latestRoomSetter()(current => current.map(room => room._id === changedRoom._id ? changedRoom : room)));
  await act(async () => finishes.forEach(finish => finish()));

  expect(api.put).toHaveBeenCalledTimes(4);
  expect(api.put).not.toHaveBeenCalledWith('/housekeeper/queued-4', expect.anything());
  expect(screen.getByRole('alert')).toHaveTextContent('Room 205: The room changed. Review its current state before trying again.');
  expect(screen.getByRole('checkbox', { name: 'Select room 205' })).not.toBeChecked();
  expect(screen.getByRole('region', { name: 'Selected rooms' })).toHaveTextContent('0 selected');
});

test('a warned stayover save keeps its primary result and retries the exact guarded service timestamp until front desk sync succeeds', async () => {
  const initialVersion = '2026-10-03T10:00:00.000Z';
  const savedVersion = '2026-10-03T11:00:00.000Z';
  const finalVersion = '2026-10-03T12:00:00.000Z';
  const initialRooms = taskRooms.map(room => room._id === 'stayover' ? { ...room, updatedAt: initialVersion } : room);
  let serviceTimestamp;
  let putCount = 0;
  api.get.mockImplementation(() => Promise.resolve({ data: { data: initialRooms.map(room => room._id === 'stayover' && serviceTimestamp ? { ...room, stayoverServicedAt: serviceTimestamp, updatedAt: savedVersion } : room) } }));
  api.put.mockImplementation((url, changes) => {
    putCount++;
    serviceTimestamp = changes.stayoverServicedAt;
    if (putCount === 2) return Promise.reject({ request: {} });
    return Promise.resolve({ data: { data: { ...initialRooms[1], stayoverServicedAt: serviceTimestamp, updatedAt: putCount === 1 ? savedVersion : finalVersion }, ...(putCount === 1 && { warning: 'Front desk synchronization is unavailable.' }) } });
  });
  open();
  await screen.findByRole('listitem', { name: 'Room 101, Dirty' });
  selectTab('Services');
  fireEvent.click(screen.getByRole('button', { name: 'Mark room 102 service done' }));
  await screen.findByRole('listitem', { name: 'Room 102, Service done' });
  expect(api.put).toHaveBeenLastCalledWith('/housekeeper/stayover', { stayoverServicedAt: serviceTimestamp, expectedUpdatedAt: initialVersion });
  expect(screen.getByRole('alert')).toHaveTextContent('Saved here; front desk sync needs retry.');
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss message' }));
  expect(screen.getByRole('button', { name: 'Retry housekeeping sync' })).toBeEnabled();
  fireEvent.click(screen.getByText('Change date or find a room'));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh rooms' }));
  await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
  expect(api.put).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Retry housekeeping sync' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Retry housekeeping sync' }));
  await screen.findByText('Front desk sync was not completed.');
  expect(screen.getByRole('alert')).toHaveTextContent('Cannot reach the server.');
  expect(screen.getByRole('alert')).toHaveTextContent('Front desk synchronization is unavailable.');
  expect(listItem('Room 102, Service done')).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Retry housekeeping sync' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Retry housekeeping sync' }));
  await screen.findByText('1 room synced to front desk.');
  expect(api.put).toHaveBeenCalledTimes(3);
  expect(api.put.mock.calls[1]).toEqual(['/housekeeper/stayover', { stayoverServicedAt: serviceTimestamp, expectedUpdatedAt: savedVersion }]);
  expect(api.put.mock.calls[2]).toEqual(['/housekeeper/stayover', { stayoverServicedAt: serviceTimestamp, expectedUpdatedAt: savedVersion }]);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Retry housekeeping sync' })).not.toBeInTheDocument();
});

test('bulk warning repair replays only warned successful rooms and preserves their saved version', async () => {
  const initialVersion = '2026-10-03T10:00:00.000Z';
  const savedVersion = '2026-10-03T11:00:00.000Z';
  const initialRooms = taskRooms.map(room => ['checkout', 'vacant'].includes(room._id) ? { ...room, updatedAt: initialVersion } : room);
  api.get.mockResolvedValue({ data: { data: initialRooms } });
  let checkoutCalls = 0;
  api.put.mockImplementation((url, changes) => {
    const room = initialRooms.find(record => url === `/housekeeper/${record._id}`);
    if (room._id === 'checkout') checkoutCalls++;
    return Promise.resolve({ data: { data: { ...room, housekeepingStatus: 'Clean', updatedAt: checkoutCalls > 1 ? '2026-10-03T12:00:00.000Z' : savedVersion }, ...(room._id === 'checkout' && checkoutCalls === 1 && { warning: 'Front desk synchronization is unavailable.' }) } });
  });
  open();
  await screen.findByRole('listitem', { name: 'Room 101, Dirty' });
  fireEvent.click(screen.getByRole('button', { name: 'Select rooms' }));
  fireEvent.click(screen.getByRole('button', { name: 'Select all visible rooms' }));
  fireEvent.click(screen.getByRole('button', { name: 'Mark selected rooms clean' }));
  await screen.findByText('2 rooms marked clean. 1 room saved; front desk sync needs retry.');
  expect(screen.getByRole('heading', { name: 'No rooms ready to clean' })).toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Selected rooms' })).toHaveTextContent('0 selected');
  fireEvent.click(screen.getByRole('button', { name: 'Retry housekeeping sync' }));
  await screen.findByText('1 room synced to front desk.');
  expect(api.put).toHaveBeenCalledTimes(3);
  expect(api.put).toHaveBeenLastCalledWith('/housekeeper/checkout', { housekeepingStatus: 'Clean', expectedUpdatedAt: savedVersion });
  expect(api.put.mock.calls.filter(([url]) => url === '/housekeeper/vacant')).toHaveLength(1);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('a warned cleaning action cannot be replayed after a same-status room changed to another checkout cycle', async () => {
  const original = { ...taskRooms[0], updatedAt: '2026-10-03T10:00:00.000Z' };
  const saved = { ...original, housekeepingStatus: 'Clean', updatedAt: '2026-10-03T11:00:00.000Z' };
  api.get.mockResolvedValue({ data: { data: taskRooms.map(room => room._id === original._id ? original : room) } });
  api.put.mockResolvedValue({ data: { data: saved, warning: 'Front desk synchronization is unavailable.' } });
  open();
  fireEvent.click(await screen.findByRole('button', { name: 'Mark room 101 clean' }));
  const retry = await screen.findByRole('button', { name: 'Retry housekeeping sync' });
  expect(retry).toBeEnabled();
  act(() => latestRoomSetter()(current => current.map(room => room._id === saved._id ? { ...saved, checkedOutAt: '2026-10-03T14:00:00.000Z', updatedAt: '2026-10-03T15:00:00.000Z' } : room)));
  expect(retry).toBeDisabled();
  expect(screen.getByRole('alert')).toHaveTextContent('Room 101 changed. Review its current state before retrying sync.');
  fireEvent.click(retry);
  expect(api.put).toHaveBeenCalledTimes(1);
});

test('ordinary message dismissal keeps sync repair available, while explicit sync-warning dismissal clears a reviewed stale warning without writing', async () => {
  const original = { ...taskRooms[0], updatedAt: '2026-10-03T10:00:00.000Z' };
  const saved = { ...original, housekeepingStatus: 'Clean', updatedAt: '2026-10-03T11:00:00.000Z' };
  api.get.mockResolvedValue({ data: { data: taskRooms.map(room => room._id === original._id ? original : room) } });
  api.put.mockResolvedValue({ data: { data: saved, warning: 'Front desk synchronization is unavailable.' } });
  open();
  fireEvent.click(await screen.findByRole('button', { name: 'Mark room 101 clean' }));
  await screen.findByRole('button', { name: 'Retry housekeeping sync' });
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss message' }));
  expect(screen.getByRole('button', { name: 'Retry housekeeping sync' })).toBeEnabled();
  expect(screen.getByRole('alert')).toHaveTextContent('Front desk synchronization is unavailable.');
  act(() => latestRoomSetter()(current => current.map(room => room._id === saved._id
    ? { ...saved, housekeepingStatus: 'Maintenance', updatedAt: '2026-10-03T12:00:00.000Z' } : room)));
  expect(screen.getByRole('button', { name: 'Retry housekeeping sync' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss sync warning' }));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Retry housekeeping sync' })).not.toBeInTheDocument();
  expect(api.put).toHaveBeenCalledTimes(1);
  expect(within(selectTab('Unavailable')).getByRole('listitem', { name: 'Room 101, Maintenance' })).toBeInTheDocument();
});

test.each([undefined, '2026-10-03T11:00:00.000Z'])('a delayed cleaning response with version %s does not overwrite newer live maintenance', async incomingVersion => {
  const original = { ...taskRooms[0], updatedAt: '2026-10-03T10:00:00.000Z' };
  let finish;
  api.get.mockResolvedValue({ data: { data: taskRooms.map(room => room._id === original._id ? original : room) } });
  api.put.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  open();
  fireEvent.click(await screen.findByRole('button', { name: 'Mark room 101 clean' }));
  act(() => latestRoomSetter()(current => current.map(room => room._id === original._id ? { ...original, housekeepingStatus: 'Maintenance', updatedAt: '2026-10-03T12:00:00.000Z' } : room)));
  await act(async () => finish({ data: { data: { housekeepingStatus: 'Clean', ...(incomingVersion && { updatedAt: incomingVersion }) } } }));
  expect(api.put).toHaveBeenCalledWith('/housekeeper/checkout', { housekeepingStatus: 'Clean', expectedUpdatedAt: original.updatedAt });
  expect(within(selectTab('Unavailable')).getByRole('listitem', { name: 'Room 101, Maintenance' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Undo room 101' })).not.toBeInTheDocument();
});

test('bulk saving locks selection and scope controls and prevents another bulk tap', async () => {
  const finishes = [];
  api.put.mockImplementation((url, changes) => new Promise(resolve => { finishes.push(() => resolve({ data: { data: changes } })); }));
  open();
  await screen.findByRole('listitem', { name: 'Room 101, Dirty' });
  fireEvent.click(screen.getByText('Change date or find a room'));
  fireEvent.click(screen.getByRole('button', { name: 'Select rooms' }));
  fireEvent.click(screen.getByRole('button', { name: 'Select all visible rooms' }));
  const save = screen.getByRole('button', { name: 'Mark selected rooms clean' });
  fireEvent.click(save);
  expect(save).toBeDisabled();
  expect(within(screen.getByRole('region', { name: 'Selected rooms' })).getByRole('status')).toHaveTextContent('Saving selected rooms');
  expect(screen.getByRole('button', { name: 'Select rooms' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Next report date' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Go to today' })).toBeDisabled();
  expect(screen.getByRole('searchbox', { name: 'Find a room' })).toBeDisabled();
  expect(screen.getByLabelText('Assigned attendant')).toBeDisabled();
  screen.getAllByRole('tab').forEach(taskTab => expect(taskTab).toBeDisabled());
  screen.getAllByRole('checkbox').forEach(checkbox => expect(checkbox).toBeDisabled());
  fireEvent.click(save);
  expect(api.put).toHaveBeenCalledTimes(2);
  await act(async () => finishes.forEach(finish => finish()));
  expect(tab('Services')).toBeEnabled();
  expect(screen.getByRole('searchbox', { name: 'Find a room' })).toBeEnabled();
});

test.each(['lost', 'moved'])('bulk completion restores lost focus without stealing focus when it was %s during saving', async focusState => {
  let finish;
  api.put.mockImplementation((url, changes) => new Promise(resolve => { finish = () => resolve({ data: { data: changes } }); }));
  open();
  await screen.findByRole('listitem', { name: 'Room 101, Dirty' });
  fireEvent.click(screen.getByRole('button', { name: 'Select rooms' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select room 101' }));
  const toolbar = screen.getByRole('region', { name: 'Selected rooms' });
  const panel = screen.getByRole('tabpanel');
  const save = screen.getByRole('button', { name: 'Mark selected rooms clean' });
  save.focus();
  expect(save).toHaveFocus();
  fireEvent.click(save);
  // Reproduce the body focus seen in browsers; jsdom will not blur a disabled button.
  panel.focus();
  panel.blur();
  expect(document.body).toHaveFocus();
  if (focusState === 'moved') panel.focus();

  await act(async () => finish());
  expect(save).toBeDisabled();
  if (focusState === 'lost') expect(toolbar).toHaveFocus();
  else {
    expect(panel).toHaveFocus();
    expect(toolbar).not.toHaveFocus();
  }
});

test('selection clears on tab, search, attendant, and date changes, and select all uses only visible rooms', async () => {
  open();
  await screen.findByRole('listitem', { name: 'Room 101, Dirty' });
  fireEvent.click(screen.getByText('Change date or find a room'));
  fireEvent.click(screen.getByRole('button', { name: 'Select rooms' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select room 101' }));
  selectTab('Services');
  expect(screen.getByRole('region', { name: 'Selected rooms' })).toHaveTextContent('0 selected');
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select room 102' }));
  fireEvent.change(screen.getByRole('searchbox', { name: 'Find a room' }), { target: { value: '102' } });
  expect(screen.getByRole('checkbox', { name: 'Select room 102' })).not.toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: 'Select all visible rooms' }));
  expect(screen.getAllByRole('checkbox')).toHaveLength(1);
  expect(screen.getByRole('region', { name: 'Selected rooms' })).toHaveTextContent('1 selected');
  expect(tab('Services')).toHaveAccessibleName('Services 2');
  fireEvent.change(screen.getByLabelText('Assigned attendant'), { target: { value: 'Maria' } });
  expect(screen.getByRole('checkbox', { name: 'Select room 102' })).not.toBeChecked();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select room 102' }));
  fireEvent.click(screen.getByRole('button', { name: 'Go to today' }));
  await waitFor(() => expect(api.get).toHaveBeenLastCalledWith('/housekeeper', expect.objectContaining({ params: { date: localDate() } })));
  expect(screen.getByRole('region', { name: 'Selected rooms' })).toHaveTextContent('0 selected');
  expect(api.put).not.toHaveBeenCalled();
});

test('live task changes remove earlier selections and waiting or unavailable rooms cannot be selected', async () => {
  open();
  await screen.findByRole('listitem', { name: 'Room 101, Dirty' });
  selectTab('Services');
  fireEvent.click(screen.getByRole('button', { name: 'Select rooms' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select room 108' }));
  act(() => latestRoomSetter()(current => current.map(room => room._id === 'serviced' ? { ...room, stayoverServicedAt: null } : room)));
  expect(listItem('Room 108, Service not done')).toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: 'Select room 108' })).not.toBeChecked();
  expect(screen.getByRole('button', { name: 'Revert selected rooms' })).toBeDisabled();
  for (const name of ['Waiting for checkout', 'Unavailable']) {
    selectTab(name);
    expect(screen.getByRole('button', { name: 'Select rooms' })).toBeDisabled();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  }
  expect(api.put).not.toHaveBeenCalled();
});

test('a selected clean room becoming a serviced stayover loses its earlier cleaning-revert selection', async () => {
  open();
  await screen.findByRole('listitem', { name: 'Room 101, Dirty' });
  selectTab('Done');
  fireEvent.click(screen.getByRole('button', { name: 'Select rooms' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select room 105' }));
  expect(screen.getByRole('button', { name: 'Revert selected rooms' })).toBeEnabled();
  act(() => latestRoomSetter()(current => current.map(room => room._id === 'done'
    ? { ...room, occupancyStatus: 'Occupied', checkOut: '2026-10-05', stayoverServicedAt: '2026-10-03T16:00:00.000Z' } : room)));
  expect(listItem('Room 105, Service done')).toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: 'Select room 105' })).not.toBeChecked();
  expect(screen.getByRole('button', { name: 'Revert selected rooms' })).toBeDisabled();
  expect(screen.getByRole('region', { name: 'Selected rooms' })).toHaveTextContent('0 selected');
  expect(api.put).not.toHaveBeenCalled();
});

test('a saving room ignores another tap then leaves Ready for Done', async () => {
  let finish;
  api.put.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  open();
  fireEvent.click(await screen.findByRole('button', { name: 'Mark room 101 clean' }));
  const saving = screen.getByRole('button', { name: 'Saving room 101' });
  expect(saving).toBeDisabled();
  expect(within(saving).getByText('Saving…')).toBeInTheDocument();
  fireEvent.click(saving);
  expect(api.put).toHaveBeenCalledTimes(1);
  await act(async () => finish({ data: { data: { housekeepingStatus: 'Clean' } } }));
  expect(screen.queryByRole('listitem', { name: /^Room 101,/ })).not.toBeInTheDocument();
  expect(tab('Ready to clean')).toHaveAttribute('aria-selected', 'true');
  expect(tab('Ready to clean')).toHaveAccessibleName('Ready to clean 1');
  expect(screen.getByText('Room 101 is clean. Front desk can see it now.')).toBeInTheDocument();
  expect(within(selectTab('Done')).getByRole('listitem', { name: 'Room 101, Clean' }).firstChild).toHaveClass('hk-tone-done');
});

test.each([
  ['Ready to clean', 'Mark room 101 clean'],
  ['Done', 'Revert room 105 cleaning']
])('keyboard focus returns to the %s panel when a saved room action leaves the tab', async (selectedTab, buttonName) => {
  api.put.mockImplementation((url, changes) => Promise.resolve({ data: { data: changes } }));
  open();
  await screen.findByRole('listitem', { name: 'Room 101, Dirty' });
  const panel = selectTab(selectedTab);
  const action = within(panel).getByRole('button', { name: buttonName });
  action.focus();
  expect(action).toHaveFocus();
  fireEvent.click(action);

  await waitFor(() => expect(action).not.toBeInTheDocument());
  expect(panel).toHaveFocus();
  expect(tab(selectedTab)).toHaveAttribute('aria-selected', 'true');
});

test('a pending room save preserves focus on a task tab selected before the save finishes', async () => {
  let finish;
  api.put.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  open();
  const action = await screen.findByRole('button', { name: 'Mark room 101 clean' });
  action.focus();
  fireEvent.click(action);
  const servicesTab = tab('Services');
  servicesTab.focus();
  fireEvent.click(servicesTab);
  expect(servicesTab).toHaveFocus();

  await act(async () => finish({ data: { data: { housekeepingStatus: 'Clean' } } }));
  expect(servicesTab).toHaveFocus();
  expect(servicesTab).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('tabpanel', { name: 'Services 2' })).not.toHaveFocus();
  expect(screen.getByRole('listitem', { name: 'Room 102, Service not done' })).toBeInTheDocument();
});

test('progress counts cleaning and stayover service independently of the selected tab', async () => {
  open();
  await screen.findByRole('listitem', { name: 'Room 101, Dirty' });
  const progress = screen.getByRole('progressbar', { name: 'Rooms completed' });
  expect(progress).toHaveAttribute('value', '2');
  expect(progress).toHaveAttribute('max', '5');
  expect(progress.parentElement).toHaveTextContent('2 of 5 done');
  selectTab('Waiting for checkout');
  expect(progress).toHaveAttribute('value', '2');
  expect(progress).toHaveAttribute('max', '5');
});

test('an empty Ready tab stays empty while waiting and blocked work remains in its tabs', async () => {
  api.get.mockResolvedValue({ data: { data: taskRooms.filter(room => ['due', 'unknown', 'blocked'].includes(room._id)) } });
  open();
  await screen.findByRole('tab', { name: 'Waiting for checkout 2' });
  const ready = screen.getByRole('tabpanel', { name: 'Ready to clean 0' });
  expect(within(ready).queryByRole('listitem', { name: /^Room / })).not.toBeInTheDocument();
  expect(within(ready).getByRole('heading', { name: 'No rooms ready to clean' })).toBeInTheDocument();
  expect(screen.getByText('Nothing to clean yet')).toBeInTheDocument();
  expect(screen.getByRole('progressbar', { name: 'Rooms completed' })).toHaveAttribute('value', '0');
  expect(within(selectTab('Waiting for checkout')).getByRole('listitem', { name: 'Room 103, Checkout' })).toBeInTheDocument();
  expect(within(selectTab('Unavailable')).getByRole('listitem', { name: 'Room 106, Out of Order' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^Mark room/ })).not.toBeInTheDocument();
});

test('live checkout moves a waiting room into Ready without changing the active tab, and cleaning clears its new flag', async () => {
  api.put.mockImplementation((url, changes) => Promise.resolve({ data: { data: changes } }));
  open();
  await screen.findByRole('listitem', { name: 'Room 101, Dirty' });
  selectTab('Waiting for checkout');
  expect(listItem('Room 103, Checkout').firstChild).toHaveClass('hk-tone-waiting');
  fireEvent.click(screen.getByText('Change date or find a room'));
  fireEvent.change(screen.getByRole('searchbox', { name: 'Find a room' }), { target: { value: '104' } });
  expect(screen.queryByRole('listitem', { name: /^Room 103,/ })).not.toBeInTheDocument();
  const initialReads = api.get.mock.calls.length;
  act(() => latestRoomSetter()(current => current.map(room => room._id === 'due'
    ? { ...room, occupancyStatus: 'Vacant', guestStatus: 'Checked-out', checkedOutAt: '2026-10-03T16:00:00.000Z' }
    : room._id === 'stayover' ? { ...room, stayoverServicedAt: '2026-10-03T16:05:00.000Z' } : room)));

  expect(tab('Waiting for checkout')).toHaveAttribute('aria-selected', 'true');
  expect(tab('Waiting for checkout')).toHaveAccessibleName('Waiting for checkout 1');
  expect(tab('Ready to clean')).toHaveAccessibleName('Ready to clean 3');
  expect(screen.queryByRole('listitem', { name: /^Room 103,/ })).not.toBeInTheDocument();
  expect(screen.getByText('Room 103 checked out. Ready to clean.')).toBeInTheDocument();
  expect(screen.getByRole('progressbar', { name: 'Rooms completed' })).toHaveAttribute('value', '3');
  expect(screen.getByRole('progressbar', { name: 'Rooms completed' })).toHaveAttribute('max', '6');
  expect(api.get).toHaveBeenCalledTimes(initialReads);

  fireEvent.click(screen.getByRole('button', { name: 'View ready rooms' }));
  const checkedOut = listItem('Room 103, Dirty');
  expect(tab('Ready to clean')).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('searchbox', { name: 'Find a room' })).toHaveValue('');
  expect(checkedOut.firstChild).toHaveClass('hk-tone-ready', 'is-new');
  expect(within(checkedOut).getByText('New')).toBeInTheDocument();
  fireEvent.click(within(checkedOut).getByRole('button', { name: 'Mark room 103 clean' }));
  await screen.findByText('Room 103 is clean. Front desk can see it now.');
  expect(api.put).toHaveBeenCalledWith('/housekeeper/due', { housekeepingStatus: 'Clean' });
  expect(screen.queryByText('New')).not.toBeInTheDocument();
  expect(screen.queryByText('Room 103 checked out. Ready to clean.')).not.toBeInTheDocument();
  expect(within(selectTab('Services')).getByRole('listitem', { name: 'Room 102, Service done' })).toBeInTheDocument();
});

test('several checkouts are announced together, and dismissing the alert clears the new flags', async () => {
  open();
  await screen.findByRole('listitem', { name: 'Room 101, Dirty' });
  act(() => latestRoomSetter()(current => current.map(room => ['due', 'unknown'].includes(room._id) ? { ...room, occupancyStatus: 'Vacant', guestStatus: 'Checked-out' } : room)));
  expect(screen.getByText('Rooms 103, 104 checked out. Ready to clean.')).toBeInTheDocument();
  expect(screen.getAllByText('New')).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss checkout alert' }));
  expect(screen.queryByText(/checked out\. Ready to clean\./)).not.toBeInTheDocument();
  expect(screen.queryByText('New')).not.toBeInTheDocument();
  expect(listItem('Room 104, Dirty').firstChild).toHaveClass('hk-tone-ready');
});

test('a board for another day says so and returns to today in one tap', async () => {
  open();
  await screen.findByRole('listitem', { name: 'Room 101, Dirty' });
  expect(screen.getByText('Saturday, Oct 3 · not today')).toBeInTheDocument();
  selectTab('Done');
  fireEvent.click(screen.getByRole('button', { name: 'Go to today' }));
  await waitFor(() => expect(api.get).toHaveBeenLastCalledWith('/housekeeper', expect.objectContaining({ params: { date: localDate() } })));
  expect(screen.queryByRole('button', { name: 'Go to today' })).not.toBeInTheDocument();
  expect(screen.getByText(/^Today · /)).toBeInTheDocument();
  expect(tab('Ready to clean')).toHaveAttribute('aria-selected', 'true');
});

test('a rejected stayover service stays in Services for retry', async () => {
  api.put.mockRejectedValue({ response: { data: { message: 'The guest has checked out. Refresh the room plan.' } } });
  open();
  await screen.findByRole('listitem', { name: 'Room 101, Dirty' });
  selectTab('Services');
  fireEvent.click(screen.getByRole('button', { name: 'Mark room 102 service done' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('The guest has checked out. Refresh the room plan.');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Mark room 102 service done' })).toBeEnabled());
  expect(listItem('Room 102, Service not done').firstChild).toHaveClass('hk-tone-stayover');
  expect(tab('Services')).toHaveAttribute('aria-selected', 'true');
  expect(screen.queryByRole('button', { name: 'Undo room 102' })).not.toBeInTheDocument();
});
