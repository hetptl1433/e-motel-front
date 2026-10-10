import React, { useContext } from 'react';
import { Navigate } from 'react-router-dom';
import { AuthContext } from '../context/authContext';

export default function ProtectedRoute({ children, roles }) {
  const { token, user, initializing, sessionError, retrySession, logout } = useContext(AuthContext);
  if (initializing) return <div className="p-8 text-center" role="status">Opening your workspace…</div>;
  if (!token) return <Navigate to="/" replace />;
  if (sessionError) return (
    <div className="max-w-lg mx-auto p-8 space-y-4">
      <p role="alert">{sessionError}</p>
      <button onClick={retrySession} className="px-4 py-2 bg-blue-600 text-white rounded-lg">Try again</button>{' '}
      <button onClick={logout} className="px-4 py-2 border rounded-lg">Sign out</button>
    </div>
  );
  if (roles && !roles.includes(user?.role)) return <Navigate to="/housekeeping" replace />;
  return children;
}
