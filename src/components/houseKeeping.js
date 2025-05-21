import React, { useState, useEffect } from 'react';
import api from '../api';
import { io } from 'socket.io-client';

// ✅ Point to correct backend socket URL
const socket = io(process.env.REACT_APP_SOCKET_URL, {
  transports: ['websocket'],
  withCredentials: true
});

const statusCycle = {
  clean: 'dirty',
  dirty: 'clean',
};

export default function HouseKeeping() {
  const [rooms, setRooms] = useState([]);

  // ✅ Check socket connection
  useEffect(() => {
    socket.on('connect', () => console.log('🟢 Socket connected:', socket.id));
    socket.on('connect_error', err => console.error('🔴 Socket error:', err.message));
  }, []);

  // ✅ Fetch rooms from /room
  useEffect(() => {
    const fetchRooms = async () => {
      try {
        const { data } = await api.get('/room'); // 👈 CORRECT: not /rooms
        setRooms(data);
      } catch (err) {
        console.error('❌ Failed to load rooms:', err);
      }
    };
    fetchRooms();
  }, []);

  // ✅ Listen to roomToggled event
  useEffect(() => {
    socket.on('roomToggled', (updatedRoom) => {
      console.log('📦 Room update received:', updatedRoom);
      setRooms((rs) =>
        rs.map((r) => (r._id === updatedRoom._id ? updatedRoom : r))
      );
    });

    return () => socket.off('roomToggled');
  }, []);

  // ✅ Toggle logic
  const toggleStatus = async (room) => {
    if (room.status === 'unavailable') return;
    const newStatus = statusCycle[room.status];
    try {
      await api.put(`/room/${room._id}`, { status: newStatus }); // 👈 CORRECT: not /rooms
      setRooms((rs) =>
        rs.map((r) =>
          r._id === room._id ? { ...r, status: newStatus } : r
        )
      );
    } catch (err) {
      console.error('❌ Failed to update status:', err);
    }
  };

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <h1 className="text-3xl font-semibold mb-6 text-center">
        Housekeeping Dashboard
      </h1>
      <div className="grid gap-4 grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        {rooms.map((room) => {
          const base = 'aspect-square flex items-center justify-center rounded-lg text-white font-bold text-xl shadow-md transition-transform';
          const color = room.status === 'clean'
            ? 'bg-green-500 hover:scale-105'
            : room.status === 'dirty'
            ? 'bg-red-500 hover:scale-105'
            : 'bg-gray-400 cursor-not-allowed';

          return (
            <div
              key={room._id}
              onClick={() => toggleStatus(room)}
              className={`${base} ${color}`}
            >
              {room.number}
            </div>
          );
        })}
      </div>
    </div>
  );
}
