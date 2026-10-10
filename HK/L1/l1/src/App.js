import React, { useContext } from 'react';
import { BrowserRouter, Routes, Route, NavLink, Outlet, Navigate, useSearchParams } from 'react-router-dom';
import { AuthProvider, AuthContext } from './context/authContext';
import ProtectedRoute from './routes/ProtectedRoutes';
import Login from './components/Login';
import './css/house.css';
import HouseKeeping from './components/houseKeeping';
import UploadReport from './components/UploadReport';
import Dashboard from './components/Dashboard';
import RoomSheets from './components/RoomSheets';
import { isReportDate } from './utils/roomData';

function Workspace() {
  const { user, logout } = useContext(AuthContext);
  const [params] = useSearchParams();
  const selectedDate = params.get('date');
  const dayQuery = isReportDate(selectedDate) ? `?date=${selectedDate}` : '';
  const manageReports = ['admin', 'frontdesk'].includes(user?.role);
  const linkClass = ({ isActive }) => `workspace-link${isActive ? ' is-active' : ''}`;
  return (
    <div className="workspace">
      <header className="workspace-header">
        <div className="workspace-header-inner">
          <NavLink to={`${manageReports ? '/dashboard' : '/housekeeping'}${dayQuery}`} className="workspace-brand"><span>E</span>-motel</NavLink>
          <nav aria-label="Main navigation" className="workspace-nav">
            {manageReports && <NavLink to={`/dashboard${dayQuery}`} className={linkClass}>Front desk</NavLink>}
            <NavLink to={`/housekeeping${dayQuery}`} className={linkClass}>Housekeeping</NavLink>
            {manageReports && <NavLink to={`/upload-report${dayQuery}`} className={linkClass}>Upload PDF</NavLink>}
            {manageReports && <NavLink to={`/room-sheets${dayQuery}`} className={linkClass}>Room sheets</NavLink>}
          </nav>
          <div className="workspace-account">
            <span>{user?.number} · {user?.role === 'frontdesk' ? 'Front desk' : user?.role === 'admin' ? 'Admin' : 'Housekeeping'}</span>
            <button onClick={logout} className="signout-action">Sign out</button>
          </div>
        </div>
      </header>
      <main><Outlet /></main>
    </div>
  );
}

function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Login />} />
          <Route element={<ProtectedRoute><Workspace /></ProtectedRoute>}>
            <Route path="/housekeeping" element={<HouseKeeping />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/upload-report" element={<ProtectedRoute roles={['frontdesk', 'admin']}><UploadReport /></ProtectedRoute>} />
            <Route path="/room-sheets" element={<RoomSheets />} />
          </Route>
          <Route path="*" element={<Navigate to="/housekeeping" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
export default App;
