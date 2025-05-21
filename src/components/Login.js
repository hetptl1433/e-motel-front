import React, { useState, useContext } from 'react';
import { useNavigate } from 'react-router-dom';
import { AuthContext } from '../context/authContext';
import '../css/Login.css';

export default function Login() {
  const [number, setNumber] = useState('');
  const [password, setPassword] = useState('');
  const { login } = useContext(AuthContext);
  const nav = useNavigate();

  const handleSubmit = async e => {
    e.preventDefault();
    try {
      await login({ number, password });
      nav('/housekeeping');
    } catch (error) {
      console.error('Login error:', error);
      alert('Login failed');
    }
  };

  return (
    <div className="login-container">
      <div className="text-center mb-8 mr-6">
        <h1 className="text-4xl font-extrabold text-white mb-2">E-motel</h1>
        <p className="text-white text-lg max-w-md mx-auto">
          Manage your housekeeper service efficiently with E-motel.
        </p>
      </div>
      <form onSubmit={handleSubmit} className="login-form animate-fadeIn">
        <h2 className="login-title">Login</h2>
        <input
          type="text"
          placeholder="ID Number"
          
          value={number}
          onChange={e => setNumber(e.target.value)}
          required
          className="login-input"
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          required
          className="login-input"
        />
        <button type="submit" className="login-button">
          Login
        </button>
        <button
          type="button"
          onClick={() => alert('Forgot Password functionality to be implemented')}
          className="forgot-password"
        >
          Forgot Password?
        </button>
      </form>
    </div>
  );
}
