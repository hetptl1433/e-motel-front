import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from './context/authContext';
import ProtectedRoute from './routes/ProtectedRoutes';
import Login from './components/Login';
import './css/house.css';
import HouseKeeping from './components/houseKeeping';
import UploadReport from './components/UploadReport';
import Dashboard from './components/Dashboard';


function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Login />} />
          
          <Route
            path="/dashboard"
            element={
              <ProtectedRoute>
                <Dashboard />
              </ProtectedRoute>
            }
          />
          <Route
            path="/upload-report"
            element={
              <ProtectedRoute>
                <UploadReport />
              </ProtectedRoute>
            }
          />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}

export default App;
