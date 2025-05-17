// src/components/HouseKeeping.js
import React, { useState, useEffect } from 'react';
import api from '../api';
import { io } from 'socket.io-client';

// Initialize socket (make sure REACT_APP_SOCKET_URL is set to e.g. "http://localhost:4000")
const socket = io(process.env.REACT_APP_SOCKET_URL);

// Only two states will toggle: clean ↔ dirty
const statusCycle = {
  clean: 'dirty',
  dirty: 'clean',
};

export default function HouseKeeping() {
  const [rooms, setRooms] = useState([]);

  // 1) Fetch rooms on mount
  useEffect(() => {
    const fetchRooms = async () => {
      try {
        const { data } = await api.get('/room'); // or '/rooms' if your backend route is plural
        setRooms(data);
      } catch (err) {
        console.error('Failed to load rooms:', err);
      }
    };
    fetchRooms();
  }, []);

  // 2) Listen for real-time updates
  useEffect(() => {
    socket.on('roomStatusChanged', (updatedRoom) => {
      setRooms((rs) =>
        rs.map((r) =>
          r._id === updatedRoom._id ? updatedRoom : r
        )
      );
    });
    return () => {
      socket.off('roomStatusChanged');
    };
  }, []);

  // 3) Toggle only clean/dirty; ignore unavailable
  const toggleStatus = async (room) => {
    if (room.status === 'unavailable') return;

    const newStatus = statusCycle[room.status];
    try {
      await api.put(`/room/${room._id}`, { status: newStatus });
      // local update will be superseded by broadcast, but keep in sync immediately:
      setRooms((rs) =>
        rs.map((r) =>
          r._id === room._id ? { ...r, status: newStatus } : r
        )
      );
    } catch (err) {
      console.error('Failed to update status:', err);
    }
  };

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <h1 className="text-3xl font-semibold mb-6 text-center">
        Housekeeping Dashboard
      </h1>
      <div className="grid gap-4 grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        {rooms.map((room) => {
          const baseClasses =
            'aspect-square flex items-center justify-center rounded-lg text-white font-bold text-xl shadow-md transition-transform';
          const colorClass =
            room.status === 'clean'
              ? 'bg-green-500 hover:scale-105'
              : room.status === 'dirty'
              ? 'bg-red-500 hover:scale-105'
              : 'bg-gray-400 cursor-not-allowed';

          return (
            <div
              key={room._id}
              onClick={() => toggleStatus(room)}
              className={`${baseClasses} ${colorClass}`}
            >
              {room.number}
            </div>
          );
        })}
      </div>
    </div>
  );
}
