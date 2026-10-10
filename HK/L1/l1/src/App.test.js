import { render, screen, fireEvent } from '@testing-library/react';
import App from './App';
import api from './api';
import { io } from 'socket.io-client';

jest.mock('./api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn() },
  SOCKET_URL: 'http://localhost:4000'
}));

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/');
  jest.clearAllMocks();
  io.mockImplementation(() => ({ on: jest.fn(), connect: jest.fn(), disconnect: jest.fn(), connected: false }));
});

test('protected links require sign-in', () => {
  window.history.replaceState({}, '', '/dashboard');
  render(<App />);
  expect(screen.getByRole('heading', { name: 'Login' })).toBeInTheDocument();
  expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
});

test('failed sign-in shows the server message and keeps the form usable', async () => {
  api.post.mockRejectedValueOnce({ response: { status: 401, data: { message: 'Invalid credentials' } } });
  render(<App />);
  fireEvent.change(screen.getByLabelText('ID Number'), { target: { value: 'staff' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'incorrect' } });
  fireEvent.click(screen.getByRole('button', { name: 'Login' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Invalid credentials');
  expect(screen.getByRole('button', { name: 'Login' })).toBeEnabled();
  expect(localStorage.getItem('token')).toBeNull();
});

jest.mock('socket.io-client', () => ({
  io: jest.fn(() => ({ on: jest.fn(), connect: jest.fn(), disconnect: jest.fn(), connected: false }))
}));

test.each([['admin', 'Front desk'], ['housekeeping', 'Housekeeping']])(
  '%s signs in to the correct workspace without a competing redirect', async (role, heading) => {
    const user = { id: 'test-user', number: 'staff', role };
    api.post.mockResolvedValueOnce({ data: { token: 'test-session', user } });
    api.get.mockImplementation(path => Promise.resolve({ data: path === '/auth/me' ? { user } : { success: true, data: [] } }));
    render(<App />);
    fireEvent.change(screen.getByLabelText('ID Number'), { target: { value: 'staff' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'test-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Login' }));
    expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('heading', { name: 'Login' })).toBeInTheDocument();
    expect(localStorage.getItem('token')).toBeNull();
  }
);
