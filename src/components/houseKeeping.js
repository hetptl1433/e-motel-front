import React, { useState, useEffect, useRef } from 'react';
import api from '../api';
import { io } from 'socket.io-client';

const statusCycle = {
  Clean: 'Dirty',
  Dirty: 'Clean',
};

export default function HouseKeeping() {
  const [rooms, setRooms] = useState([]);
  const socketRef = useRef(null);

  // 1) Create socket once and wire up all events
  useEffect(() => {
    if (socketRef.current) return; // already initialized

    console.log('🔌 Creating SINGLE socket connection…');
    const socket = io(process.env.REACT_APP_SOCKET_URL, {
      transports: ['websocket', 'polling'],
      withCredentials: true,
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      console.log('🟢 Socket connected:', socket.id);
    });
    socket.on('connect_error', err => {
      console.error('🔴 Socket connection error:', err.message);
    });
    socket.on('disconnect', reason => {
      console.warn('⚡ Socket disconnected:', reason);
    });

    // LIST event: { action, count, data: [...] }
    socket.on('housekeepingListUpdated', ({ data }) => {
      console.log('📥 [Socket] housekeepingListUpdated:', data);
      setRooms(Array.isArray(data) ? data : []);
    });

    // UPDATE event: { action, recordId, roomNumber, updates, data: { … } }
    socket.on('housekeepingStatusUpdated', ({ data }) => {
      console.log('📥 [Socket] housekeepingStatusUpdated:', data);
      setRooms(prev =>
        prev.map(r => (r._id === data._id ? { ...r, ...data } : r))
      );
    });

    return () => {
      console.log('🔌 Cleaning up socket…');
      socket.disconnect();
    };
  }, []);

  // 2) Initial fetch
  const fetchRooms = async () => {
    try {
      const { data } = await api.get('/housekeeper');
      console.log('📊 Housekeeper API response:', data);
      setRooms(data.data ?? data);
    } catch (err) {
      console.error('❌ Failed to load rooms:', err);
      setRooms([]);
    }
  };

  useEffect(() => {
    fetchRooms();
  }, []);

  // 3) Toggle status
  const toggleStatus = async room => {
    console.log('🔄 Toggling room status:', room.roomNumber, 'from', room.housekeepingStatus);
    const newStatus = statusCycle[room.housekeepingStatus];
    console.log('🎯 New status will be:', newStatus);

    try {
      const response = await api.put(`/housekeeper/${room._id}`, { housekeepingStatus: newStatus });
      console.log('✅ API response:', response.data);
      // Optimistic update; real update comes via socket
      setRooms(prev =>
        prev.map(r =>
          r._id === room._id ? { ...r, housekeepingStatus: newStatus } : r
        )
      );
    } catch (err) {
      console.error('❌ Failed to update status:', err.response?.data || err);
    }
  };

  const socket = socketRef.current;

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <h1 className="text-3xl font-semibold mb-6 text-center">
        Housekeeping Dashboard
      </h1>

      {/* Debug Panel */}
      <div className="mb-4 p-3 bg-gray-100 rounded-lg text-sm">
        <div className="flex justify-between items-center">
          <div>
            <div>
              🔗 Socket Status:{' '}
              <span className={socket?.connected ? 'text-green-600 font-bold' : 'text-red-600 font-bold'}>
                {socket?.connected ? '✅ Connected' : '❌ Disconnected'}
              </span>
            </div>
            <div>🆔 Socket ID: <span className="font-mono">{socket?.id || 'None'}</span></div>
            <div>📊 Rooms Count: <span className="font-bold">{rooms.length}</span></div>
          </div>
          <button
            onClick={fetchRooms}
            className="px-3 py-1 bg-blue-500 text-white rounded hover:bg-blue-600"
          >
            🔄 Refresh
          </button>
        </div>
      </div>

      {/* Room Grid */}
      <div className="grid gap-4 grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        {rooms.map(room => {
          const color =
            room.housekeepingStatus === 'Clean'
              ? 'bg-green-500 hover:scale-105'
              : room.housekeepingStatus === 'Dirty'
              ? 'bg-red-500 hover:scale-105'
              : 'bg-gray-400 cursor-not-allowed';

          return (
            <div
              key={room._id}
              onClick={() => toggleStatus(room)}
              className={`aspect-square flex items-center justify-center rounded-lg text-white font-bold text-xl shadow-md transition-transform ${color}`}
            >
              {room.roomNumber}
            </div>
          );
        })}
        {rooms.length === 0 && (
          <div className="col-span-full text-center text-gray-500 py-8">
            No rooms available. Try importing from dashboard first.
          </div>
        )}
      </div>
    </div>
  );
}
