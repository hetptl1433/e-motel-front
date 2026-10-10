import { useContext } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import api from '../api';
import { AuthContext, AuthProvider } from './authContext';

jest.mock('../api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn() }
}));

const user = { id: 'staff-id', number: '201', role: 'frontdesk' };

function Session({ date = '2026-10-10' }) {
  const { user: account, initializing, login, logout, sessionError, retrySession } = useContext(AuthContext);
  return <>
    <output aria-label="Session">{initializing ? 'Checking session' : account?.role || 'Signed out'}</output>
    <span>{date}</span>
    {sessionError && <p role="alert">{sessionError}</p>}
    <button onClick={() => login({ number: '201', password: 'offline-test-password' })}>Sign in</button>
    <button onClick={logout}>Sign out</button>
    <button onClick={retrySession}>Retry session</button>
  </>;
}

beforeEach(() => {
  localStorage.clear();
  jest.clearAllMocks();
});

afterEach(() => jest.restoreAllMocks());

test('sign-in remains stored across reloads and report-date changes late in the 365-day session', async () => {
  const signedInAt = Date.now();
  api.post.mockResolvedValueOnce({ data: { token: 'remembered-session', user } });
  api.get.mockResolvedValue({ data: { user } });
  const { unmount } = render(<AuthProvider><Session /></AuthProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(await screen.findByText('frontdesk')).toBeInTheDocument();
  expect(localStorage.getItem('token')).toBe('remembered-session');
  unmount();

  jest.spyOn(Date, 'now').mockReturnValue(signedInAt + 364 * 24 * 3600 * 1000);
  api.get.mockResolvedValue({ data: { user: { ...user, role: 'housekeeping' } } });
  const { rerender } = render(<AuthProvider><Session /></AuthProvider>);
  expect(await screen.findByText('housekeeping')).toBeInTheDocument();
  expect(api.get).toHaveBeenLastCalledWith('/auth/me', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  const sessionReads = api.get.mock.calls.length;
  rerender(<AuthProvider><Session date="2027-10-09" /></AuthProvider>);
  expect(screen.getByLabelText('Session')).toHaveTextContent('housekeeping');
  expect(api.get).toHaveBeenCalledTimes(sessionReads);
  expect(localStorage.getItem('token')).toBe('remembered-session');
});

test('a temporary session lookup outage keeps the stored login and retry restores the current account', async () => {
  localStorage.setItem('token', 'remembered-session');
  api.get.mockRejectedValueOnce({ response: { status: 503, data: { message: 'Database unavailable' } } });
  api.get.mockResolvedValueOnce({ data: { user } });
  render(<AuthProvider><Session /></AuthProvider>);
  expect(await screen.findByRole('alert')).toHaveTextContent('Database unavailable');
  expect(localStorage.getItem('token')).toBe('remembered-session');
  fireEvent.click(screen.getByRole('button', { name: 'Retry session' }));
  expect(await screen.findByText('frontdesk')).toBeInTheDocument();
  expect(localStorage.getItem('token')).toBe('remembered-session');
});

test('the server session-expired signal clears a remembered token and explicit sign-out still works', async () => {
  localStorage.setItem('token', 'remembered-session');
  api.get.mockResolvedValue({ data: { user } });
  api.post.mockResolvedValueOnce({ data: { token: 'replacement-session', user } });
  render(<AuthProvider><Session /></AuthProvider>);
  expect(await screen.findByText('frontdesk')).toBeInTheDocument();
  fireEvent(window, new Event('session-expired'));
  expect(screen.getByLabelText('Session')).toHaveTextContent('Signed out');
  expect(localStorage.getItem('token')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(await screen.findByText('frontdesk')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
  expect(screen.getByLabelText('Session')).toHaveTextContent('Signed out');
  expect(localStorage.getItem('token')).toBeNull();
});
