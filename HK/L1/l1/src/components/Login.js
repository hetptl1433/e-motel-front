import React, { useState, useContext } from 'react';
import { Navigate } from 'react-router-dom';
import { AuthContext } from '../context/authContext';
import '../css/Login.css';
import Brand from './Brand';

export default function Login() {
  const [number, setNumber] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { login, token, user, initializing } = useContext(AuthContext);
  if (token && initializing) return <p role="status" className="p-8 text-center">Opening your workspace…</p>;
  if (token) return <Navigate to={user?.role === 'housekeeping' ? '/housekeeping' : '/dashboard'} replace />;

  const handleSubmit = async event => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await login({ number, password });
    } catch (failure) {
      setError(failure.response?.data?.message || 'Cannot reach the server. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-container">
      <div className="login-intro">
        <h1 className="login-brand"><Brand inverse /></h1>
        <p className="text-white text-lg">A clearer view of every room, every day.</p>
        <p className="text-blue-100 mt-3">Room reports, cleaning assignments, and daily room sheets in one workspace.</p>
      </div>
      <form onSubmit={handleSubmit} className="login-form">
        <h2 className="login-title">Login</h2>
        <label htmlFor="login-number" className="block text-sm font-medium text-gray-700 mb-1">ID Number</label>
        <input id="login-number" type="text" autoComplete="username" value={number}
          onChange={event => setNumber(event.target.value)} required maxLength={100}
          disabled={busy} className="login-input" />
        <label htmlFor="login-password" className="block text-sm font-medium text-gray-700 mb-1">Password</label>
        <input id="login-password" type="password" autoComplete="current-password" value={password}
          onChange={event => setPassword(event.target.value)} required disabled={busy} className="login-input" />
        {error && <p role="alert" className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
        <button type="submit" disabled={busy} className="login-button">{busy ? 'Signing in…' : 'Login'}</button>
        <p className="mt-5 text-center text-sm text-gray-500">For account access or a password reset, contact your motel administrator.</p>
      </form>
    </div>
  );
}
