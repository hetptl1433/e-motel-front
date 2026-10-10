import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext } from '../context/authContext';
import api from '../api';
import useRoomRealtime from '../hooks/useRoomRealtime';
import Dashboard from './Dashboard';

jest.mock('../api', () => ({ __esModule: true, default: { get: jest.fn(), put: jest.fn(), post: jest.fn() } }));
jest.mock('../hooks/useRoomRealtime', () => ({ __esModule: true, default: jest.fn() }));

const date = '2026-10-03';
const initialVersion = `${date}T12:00:01.000Z`;
const savedVersion = `${date}T12:00:02.000Z`;
const nextVersion = `${date}T12:00:03.000Z`;
const warning = 'Room updated, but housekeeping synchronization failed. Refresh and try the change again.';
const response = (room, message) => ({ data: { data: room, ...(message ? { warning: message } : {}) } });

function departingRoom(number) {
  return {
    _id: `room-${number}`, roomNumber: number, reportDate: date,
    occupancyStatus: 'Occupied', housekeepingStatus: 'Dirty', guestStatus: 'Due Out',
    checkIn: '2026-10-01', checkOut: date, updatedAt: initialVersion
  };
}

function checkedOutRoom(room) {
  return { ...room, occupancyStatus: 'Vacant', guestStatus: 'Checked-out', checkedOutAt: savedVersion, stayoverServicedAt: null, updatedAt: savedVersion };
}

function serverSnapshot(rooms) {
  const state = { rooms };
  api.get.mockImplementation(() => Promise.resolve({ data: { data: state.rooms } }));
  return state;
}

function updateServer(state, room) {
  state.rooms = state.rooms.map(current => current._id === room._id ? room : current);
}

function open() {
  return render(<MemoryRouter initialEntries={[`/dashboard?date=${date}`]}><AuthContext.Provider value={{ user: { role: 'frontdesk' }, token: 'test-session' }}><Dashboard /></AuthContext.Provider></MemoryRouter>);
}

function liveUpdate(rooms) {
  const { setRooms } = useRoomRealtime.mock.calls[useRoomRealtime.mock.calls.length - 1][0];
  act(() => setRooms(rooms));
}

beforeEach(() => {
  jest.resetAllMocks();
  localStorage.clear();
  useRoomRealtime.mockReturnValue(true);
});

test('repairs a checkout warning by repeating guarded checkout for the saved vacant room', async () => {
  const initial = departingRoom('201');
  const saved = checkedOutRoom(initial);
  const repaired = { ...saved, updatedAt: nextVersion };
  const state = serverSnapshot([initial]);
  api.post.mockImplementationOnce(async () => { updateServer(state, saved); return response(saved, warning); })
    .mockImplementationOnce(async () => { updateServer(state, repaired); return response(repaired); });
  open();

  fireEvent.click(await screen.findByRole('button', { name: 'Check out room 201' }));
  const retry = await screen.findByRole('button', { name: 'Retry housekeeping sync' });
  expect(api.post).toHaveBeenCalledWith('/room/room-201/checkout', { expectedUpdatedAt: initialVersion });
  expect(screen.queryByRole('button', { name: 'Check out room 201' })).not.toBeInTheDocument();
  fireEvent.click(retry);

  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
  expect(api.post).toHaveBeenLastCalledWith('/room/room-201/checkout', { expectedUpdatedAt: savedVersion });
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry housekeeping sync' })).not.toBeInTheDocument());
  expect(api.put).not.toHaveBeenCalled();
});

test('repairs an editor warning with a guarded replay of exactly the saved changes', async () => {
  const initial = { ...departingRoom('202'), occupancyStatus: 'Vacant', guestStatus: 'Checked-out', notes: 'Original note' };
  const changes = { notes: 'Leave extra pillows' };
  const saved = { ...initial, ...changes, updatedAt: savedVersion };
  const repaired = { ...saved, updatedAt: nextVersion };
  const state = serverSnapshot([initial]);
  api.put.mockImplementationOnce(async () => { updateServer(state, saved); return response(saved, warning); })
    .mockImplementationOnce(async () => { updateServer(state, repaired); return response(repaired); });
  open();
  fireEvent.click(within(screen.getByRole('group', { name: 'Filter rooms by status' })).getByRole('button', { name: /All rooms/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Edit room 202' }));
  const editor = screen.getByRole('form', { name: 'Edit room 202' });
  fireEvent.change(within(editor).getByLabelText('Notes'), { target: { value: changes.notes } });
  fireEvent.click(within(editor).getByRole('button', { name: 'Save' }));

  const retry = await screen.findByRole('button', { name: 'Retry housekeeping sync' });
  expect(screen.queryByRole('form', { name: 'Edit room 202' })).not.toBeInTheDocument();
  fireEvent.click(retry);
  await waitFor(() => expect(api.put).toHaveBeenCalledTimes(2));
  expect(api.put).toHaveBeenLastCalledWith('/room/room-202', { ...changes, expectedUpdatedAt: savedVersion });
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry housekeeping sync' })).not.toBeInTheDocument());
  expect(api.post).not.toHaveBeenCalled();
});

test('a newer live version prevents replaying a checkout warning even when the room remains vacant', async () => {
  const initial = departingRoom('203');
  const saved = checkedOutRoom(initial);
  const state = serverSnapshot([initial]);
  api.post.mockImplementationOnce(async () => { updateServer(state, saved); return response(saved, warning); });
  open();
  fireEvent.click(await screen.findByRole('button', { name: 'Check out room 203' }));
  await screen.findByRole('button', { name: 'Retry housekeeping sync' });

  const newer = { ...saved, housekeepingStatus: 'Clean', notes: 'Another attendant finished cleaning', updatedAt: nextVersion };
  updateServer(state, newer);
  liveUpdate([newer]);
  const retry = screen.getByRole('button', { name: 'Retry housekeeping sync' });
  expect(retry).toBeDisabled();
  expect(screen.getByRole('region', { name: 'Housekeeping synchronization' })).toHaveTextContent('A room changed.');
  await act(async () => fireEvent.click(retry));

  expect(api.post).toHaveBeenCalledTimes(1);
  expect(api.put).not.toHaveBeenCalled();
  fireEvent.click(within(screen.getByRole('group', { name: 'Filter rooms by status' })).getByRole('button', { name: /All rooms/ }));
  expect(within(screen.getByRole('article', { name: 'Room 203, Done' })).getByText(newer.notes)).toBeInTheDocument();
});

test('a newer live editor record cannot be overwritten by retrying older saved notes', async () => {
  const initial = { ...departingRoom('204'), occupancyStatus: 'Vacant', guestStatus: 'Checked-out', notes: 'Original note' };
  const saved = { ...initial, notes: 'First desk note', updatedAt: savedVersion };
  const state = serverSnapshot([initial]);
  api.put.mockImplementationOnce(async () => { updateServer(state, saved); return response(saved, warning); });
  open();
  fireEvent.click(within(screen.getByRole('group', { name: 'Filter rooms by status' })).getByRole('button', { name: /All rooms/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Edit room 204' }));
  const editor = screen.getByRole('form', { name: 'Edit room 204' });
  fireEvent.change(within(editor).getByLabelText('Notes'), { target: { value: saved.notes } });
  fireEvent.click(within(editor).getByRole('button', { name: 'Save' }));
  await screen.findByRole('button', { name: 'Retry housekeeping sync' });

  const newer = { ...saved, notes: 'Newest guest instruction', updatedAt: nextVersion };
  updateServer(state, newer);
  liveUpdate([newer]);
  const retry = screen.getByRole('button', { name: 'Retry housekeeping sync' });
  expect(retry).toBeDisabled();
  await act(async () => fireEvent.click(retry));

  expect(api.put).toHaveBeenCalledTimes(1);
  expect(api.post).not.toHaveBeenCalled();
  expect(within(screen.getByRole('article', { name: 'Room 204, Ready to clean' })).getByText(newer.notes)).toBeInTheDocument();
});

test('bulk sync repair replays warned successful rooms without repeating clean successes or failed checkouts', async () => {
  const initialRooms = ['301', '302', '303'].map(departingRoom);
  const state = serverSnapshot(initialRooms);
  let warnedCalls = 0;
  api.post.mockImplementation(async url => {
    const room = state.rooms.find(current => url === `/room/${current._id}/checkout`);
    if (room.roomNumber === '303') throw Object.assign(new Error('Guest is still in the room'), { response: { data: { message: 'Guest is still in the room' } } });
    if (room.roomNumber === '302') warnedCalls += 1;
    const saved = { ...checkedOutRoom(room), updatedAt: warnedCalls > 1 && room.roomNumber === '302' ? nextVersion : savedVersion };
    updateServer(state, saved);
    return response(saved, room.roomNumber === '302' && warnedCalls === 1 ? warning : undefined);
  });
  open();
  await screen.findByRole('button', { name: 'Check out room 301' });
  fireEvent.click(screen.getByRole('button', { name: 'Select rooms' }));
  fireEvent.click(screen.getByRole('button', { name: 'Select all visible rooms' }));
  fireEvent.click(screen.getByRole('button', { name: 'Check out selected' }));
  const retry = await screen.findByRole('button', { name: 'Retry housekeeping sync' });
  expect(api.post).toHaveBeenCalledTimes(3);
  fireEvent.click(retry);

  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(4));
  expect(api.post).toHaveBeenLastCalledWith('/room/room-302/checkout', { expectedUpdatedAt: savedVersion });
  expect(api.post.mock.calls.filter(([url]) => url === '/room/room-301/checkout')).toHaveLength(1);
  expect(api.post.mock.calls.filter(([url]) => url === '/room/room-303/checkout')).toHaveLength(1);
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry housekeeping sync' })).not.toBeInTheDocument());
});

test('a successful later notes edit does not erase an earlier unresolved checkout warning', async () => {
  const initial = departingRoom('205');
  const saved = checkedOutRoom(initial);
  const edited = { ...saved, notes: 'Leave the window closed', updatedAt: nextVersion };
  const state = serverSnapshot([initial]);
  api.post.mockImplementationOnce(async () => { updateServer(state, saved); return response(saved, warning); });
  api.put.mockImplementationOnce(async () => { updateServer(state, edited); return response(edited); });
  open();
  fireEvent.click(await screen.findByRole('button', { name: 'Check out room 205' }));
  await screen.findByRole('button', { name: 'Retry housekeeping sync' });
  fireEvent.click(within(screen.getByRole('group', { name: 'Filter rooms by status' })).getByRole('button', { name: /All rooms/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Edit room 205' }));
  const editor = screen.getByRole('form', { name: 'Edit room 205' });
  fireEvent.change(within(editor).getByLabelText('Notes'), { target: { value: edited.notes } });
  fireEvent.click(within(editor).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(screen.queryByRole('form', { name: 'Edit room 205' })).not.toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }));

  const unresolved = screen.getByRole('region', { name: 'Housekeeping synchronization' });
  expect(unresolved).toHaveTextContent('room 205');
  expect(unresolved).toHaveTextContent('A room changed.');
  expect(within(unresolved).getByRole('button', { name: 'Retry housekeeping sync' })).toBeDisabled();
  expect(api.post).toHaveBeenCalledTimes(1);
  expect(api.put).toHaveBeenCalledTimes(1);
});

test('a conflicting live note keeps the draft and prevents overwriting another staff member', async () => {
  const initial = { ...departingRoom('206'), occupancyStatus: 'Vacant', guestStatus: 'Checked-out', notes: 'Original note' };
  const state = serverSnapshot([initial]);
  open();
  fireEvent.click(within(screen.getByRole('group', { name: 'Filter rooms by status' })).getByRole('button', { name: /All rooms/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Edit room 206' }));
  const editor = screen.getByRole('form', { name: 'Edit room 206' });
  fireEvent.change(within(editor).getByLabelText('Notes'), { target: { value: 'My unfinished instruction' } });
  const newer = { ...initial, notes: 'Another desk added a crib request', updatedAt: savedVersion };
  updateServer(state, newer);
  liveUpdate([newer]);
  fireEvent.click(within(editor).getByRole('button', { name: 'Save' }));

  expect(await within(editor).findByRole('alert')).toHaveTextContent('Another staff member changed this room while you were editing. Your draft is kept.');
  expect(within(editor).getByLabelText('Notes')).toHaveValue('My unfinished instruction');
  expect(within(editor).getByRole('button', { name: 'Save' })).toBeEnabled();
  expect(api.put).not.toHaveBeenCalled();
});

test('a live stay extension prevents saving an operational draft for the previously departing guest', async () => {
  const initial = departingRoom('207');
  const state = serverSnapshot([initial]);
  open();
  fireEvent.click(await screen.findByRole('button', { name: 'Edit room 207' }));
  const editor = screen.getByRole('form', { name: 'Edit room 207' });
  fireEvent.change(within(editor).getByLabelText('Occupancy'), { target: { value: 'Vacant' } });
  const continuing = { ...initial, guestStatus: 'Stay Over', checkOut: '2026-10-05', updatedAt: savedVersion };
  updateServer(state, continuing);
  liveUpdate([continuing]);
  fireEvent.click(within(editor).getByRole('button', { name: 'Save' }));

  expect(await within(editor).findByRole('alert')).toHaveTextContent('Another staff member changed this room while you were editing. Your draft is kept.');
  expect(within(editor).getByLabelText('Occupancy')).toHaveValue('Vacant');
  expect(screen.getByRole('form', { name: 'Edit room 207' })).toBeInTheDocument();
  expect(api.put).not.toHaveBeenCalled();
  expect(api.post).not.toHaveBeenCalled();
});
