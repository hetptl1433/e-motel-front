import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from './context/authContext';
import ProtectedRoute from './routes/ProtectedRoutes';
import Login from './components/Login';
import './css/house.css';
import HouseKeeping from './components/houseKeeping';



function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Login />} />
          <Route path="/h" element={<HouseKeeping />} />

          <Route
            path="/housekeeping"
            element={
              <ProtectedRoute>
                <HouseKeeping />
              </ProtectedRoute>
            }
          />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}

export default App;
