import React, { createContext, useState, useEffect, useCallback, useMemo } from 'react';
import api from '../api';

export const AuthContext = createContext();

export function AuthProvider({ children }) {
  const [token, setToken] = useState(() => localStorage.getItem('token'));
  const [user, setUser] = useState(null);
  const [initializing, setInitializing] = useState(() => Boolean(localStorage.getItem('token')));
  const [sessionError, setSessionError] = useState('');
  const [retry, setRetry] = useState(0);

  const logout = useCallback(() => {
    localStorage.removeItem('token');
    setToken(null);
    setUser(null);
    setSessionError('');
    setInitializing(false);
  }, []);

  useEffect(() => {
    window.addEventListener('session-expired', logout);
    const syncSession = event => {
      if (event.key === 'token') {
        const nextToken = localStorage.getItem('token');
        setInitializing(Boolean(nextToken));
        setUser(null);
        setToken(nextToken);
      }
    };
    window.addEventListener('storage', syncSession);
    return () => {
      window.removeEventListener('session-expired', logout);
      window.removeEventListener('storage', syncSession);
    };
  }, [logout]);

  useEffect(() => {
    if (!token) { setInitializing(false); return; }
    const controller = new AbortController();
    setInitializing(true);
    setSessionError('');
    api.get('/auth/me', { signal: controller.signal })
      .then(response => { if (!controller.signal.aborted) setUser(response.data.user); })
      .catch(error => {
        if (!controller.signal.aborted && error.response?.status !== 401) {
          setSessionError(error.response?.data?.message || 'Cannot reach the server. Check your connection and try again.');
        }
      })
      .finally(() => { if (!controller.signal.aborted) setInitializing(false); });
    return () => controller.abort();
  }, [token, retry]);

  const login = useCallback(async ({ number, password }) => {
    const response = await api.post('/auth/login', { number: number.trim(), password });
    localStorage.setItem('token', response.data.token);
    setUser(response.data.user);
    setSessionError('');
    setToken(response.data.token);
    return response.data.user;
  }, []);
  const retrySession = useCallback(() => setRetry(value => value + 1), []);
  const value = useMemo(() => ({ token, user, login, logout, initializing, sessionError, retrySession }),
    [token, user, login, logout, initializing, sessionError, retrySession]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
