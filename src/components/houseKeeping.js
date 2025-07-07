import React, { useState, useEffect } from 'react';
import api from '../api';
import { io } from 'socket.io-client';

const statusCycle = {
  Clean: 'Dirty',
  Dirty: 'Clean',
};

export default function HouseKeeping() {
  const [rooms, setRooms] = useState([]);
  const [socket, setSocket] = useState(null);
  const [socketCreated, setSocketCreated] = useState(false);

  useEffect(() => {
    // CRITICAL: Only create socket ONCE per component lifecycle
    if (socketCreated || socket) {
      console.log('🚫 Socket already exists, skipping creation');
      return;
    }

    console.log('🔌 Creating SINGLE socket connection...');
    setSocketCreated(true);
    
    const newSocket = io(process.env.REACT_APP_SOCKET_URL, {
      forceNew: false,
      reconnection: true,
      reconnectionDelay: 1000,
      maxReconnectionAttempts: 3,
      timeout: 5000,
      transports: ['websocket', 'polling'],
      withCredentials: true
    });

    setSocket(newSocket);

    newSocket.on('connect', () => {
      console.log('🟢 Socket connected ONCE:', newSocket.id);
      console.log('🔗 Socket connected status:', newSocket.connected);
      console.log('🌐 Transport:', newSocket.io.engine.transport.name);
    });
    
    newSocket.on('connect_error', err => {
      console.error('🔴 Socket connection error:', err.message);
    });

    newSocket.on('disconnect', (reason) => {
      console.warn('⚡ Socket disconnected:', reason);
      if (reason === 'io server disconnect') {
        // Server disconnected, reconnect manually
        newSocket.connect();
      }
    });

    newSocket.on('reconnect', (attemptNumber) => {
      console.log('🔄 Socket reconnected after', attemptNumber, 'attempts');
    });

    newSocket.on('reconnect_error', (error) => {
      console.error('🔴 Socket reconnection failed:', error.message);
    });

    return () => {
      console.log('🔌 Component unmounting - cleaning up socket...');
      if (newSocket) {
        newSocket.disconnect();
        newSocket.removeAllListeners();
      }
      setSocketCreated(false);
    };
  }, []); // CRITICAL: Empty array - never re-run!

  // Fetch rooms from /housekeeper
  const fetchRooms = async () => {
    try {
      const { data } = await api.get('/housekeeper');
      console.log('📊 Housekeeper API response:', data);
      
      // Handle different response structures
      if (Array.isArray(data)) {
        setRooms(data);
      } else if (data && Array.isArray(data.data)) {
        setRooms(data.data);
      } else if (data && Array.isArray(data.rooms)) {
        setRooms(data.rooms);
      } else {
        console.warn('⚠️ Unexpected API response structure:', data);
        setRooms([]);
      }
    } catch (err) {
      console.error('❌ Failed to load rooms:', err);
      setRooms([]);
    }
  };

  useEffect(() => {
    fetchRooms();
  }, []);

  // Listen to housekeepingStatusUpdated event
  useEffect(() => {
    if (!socket || !socket.connected) {
      console.log('⏳ Socket not ready yet, skipping event listener setup');
      return;
    }

    console.log('👂 Setting up socket event listeners ONCE...');

    const handleRoomStatusChanged = (updatedRoom) => {
      console.log('📦 Real-time update received:', updatedRoom?.roomNumber, updatedRoom?.housekeepingStatus);

      setRooms((prevRooms) => {
        const updatedRooms = prevRooms.map((r) => 
          r._id === updatedRoom._id ? { ...r, ...updatedRoom } : r
        );
        console.log('🔄 Room state updated via socket');
        return updatedRooms;
      });
    };

    // Event names to listen for
    const eventNames = [
      'housekeepingStatusUpdated',
      'housekeepingRecordUpdated'
    ];

    // Remove existing listeners to prevent duplicates
    eventNames.forEach(eventName => {
      socket.off(eventName);
    });

    // Add fresh listeners
    eventNames.forEach(eventName => {
      socket.on(eventName, (data) => {
        console.log(`🎉 Socket event: ${eventName}`, data);
        if (data && data._id) {
          handleRoomStatusChanged(data);
        }
      });
    });

    console.log('✅ Socket event listeners active for:', eventNames);

    return () => {
      console.log('🧹 Removing socket event listeners...');
      eventNames.forEach(eventName => {
        socket.off(eventName);
      });
    };
  }, [socket?.connected]); // Only depend on socket connection status

  // Toggle logic
  const toggleStatus = async (room) => {
    console.log('🔄 Toggling room status:', room.roomNumber, 'from', room.housekeepingStatus);
    
    if (room.housekeepingStatus === 'unavailable') return;
    
    const newStatus = statusCycle[room.housekeepingStatus];
    console.log('🎯 New status will be:', newStatus);
    
    try {
      console.log('📡 Making API call to PUT /housekeeper/' + room._id);
      const response = await api.put(`/housekeeper/${room._id}`, { housekeepingStatus: newStatus });
      console.log('✅ API response:', response.data);
      
      setRooms((rs) =>
        rs.map((r) =>
          r._id === room._id ? { ...r, housekeepingStatus: newStatus } : r
        )
      );
      
      console.log('🔄 Local state updated for room:', room.roomNumber);
    } catch (err) {
      console.error('❌ Failed to update status:', err);
      console.error('❌ Error details:', err.response?.data);
    }
  };

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <h1 className="text-3xl font-semibold mb-6 text-center">
        Housekeeping Dashboard
      </h1>
      
      {/* Debug Info */}
      <div className="mb-4 p-3 bg-gray-100 rounded-lg text-sm">
        <div className="flex justify-between items-center">
          <div>
            <div>🔗 Socket Status: <span className={socket?.connected ? 'text-green-600 font-bold' : 'text-red-600 font-bold'}>
              {socket?.connected ? '✅ Connected' : '❌ Disconnected'}
            </span></div>
            <div>🆔 Socket ID: <span className="font-mono">{socket?.id || 'None'}</span></div>
            <div>� Socket Created: <span className={socketCreated ? 'text-green-600' : 'text-gray-500'}>
              {socketCreated ? 'Yes' : 'No'}
            </span></div>
            <div>�📊 Rooms Count: <span className="font-bold">{rooms.length}</span></div>
            <div>🔗 Socket URL: <span className="font-mono text-xs">{process.env.REACT_APP_SOCKET_URL}</span></div>
            <div>🚀 Transport: <span className="font-mono">{socket?.io?.engine?.transport?.name || 'None'}</span></div>
          </div>
          <button
            onClick={() => {
              console.log('🔄 Manual refresh triggered');
              fetchRooms();
            }}
            className="px-3 py-1 bg-blue-500 text-white rounded hover:bg-blue-600"
          >
            🔄 Refresh
          </button>
        </div>
      </div>
      
      <div className="grid gap-4 grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        {Array.isArray(rooms) && rooms.length > 0 ? (
          rooms.map((room) => {
            const base = 'aspect-square flex items-center justify-center rounded-lg text-white font-bold text-xl shadow-md transition-transform';
            const color = room.housekeepingStatus === 'Clean'
              ? 'bg-green-500 hover:scale-105'
              : room.housekeepingStatus === 'Dirty'
              ? 'bg-red-500 hover:scale-105'
              : 'bg-gray-400 cursor-not-allowed';

            return (
              <div
                key={room._id}
                onClick={() => toggleStatus(room)}
                className={`${base} ${color}`}
              >
                {room.roomNumber}
              </div>
            );
          })
        ) : (
          <div className="col-span-full text-center text-gray-500 py-8">
            No rooms available. Try importing from dashboard first.
          </div>
        )}
      </div>
    </div>
  );
}
