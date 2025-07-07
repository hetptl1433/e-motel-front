import React, { useState, useEffect } from 'react';
import api from '../api';

export default function Dashboard() {
  const [rooms, setRooms] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split('T')[0]);
  const [editingRoom, setEditingRoom] = useState(null);
  const [editingData, setEditingData] = useState({});
  const [sortBy, setSortBy] = useState('room');
  const [showPopup, setShowPopup] = useState(false);
  const [popupMessage, setPopupMessage] = useState('');
  const [popupType, setPopupType] = useState('success'); // 'success' or 'error'
  const [filterBy, setFilterBy] = useState({
    status: 'all',
    occupancy: 'all',
    pet: 'all',
    dateType: 'none',
    dateRange: { start: '', end: '' }
  });

  useEffect(() => {
    fetchRoomData(selectedDate);
  }, [selectedDate]);

  const fetchRoomData = async (date) => {
    try {
      setLoading(true);
      const response = await api.get(`/room/status/${date}`);
      setRooms(response.data);
      setError(null);
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'An error occurred');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const getStatusColor = (housekeepingStatus, occupancyStatus, pet) => {
    if (pet) {
      // Pet rooms get darker background colors
      if (housekeepingStatus === 'Clean' && occupancyStatus === 'Vacant') {
        return 'bg-green-300';
      } else if (housekeepingStatus === 'Clean' && occupancyStatus === 'Occupied') {
        return 'bg-blue-300';
      } else if (housekeepingStatus === 'Dirty' && occupancyStatus === 'Vacant') {
        return 'bg-yellow-300';
      } else if (housekeepingStatus === 'Dirty' && occupancyStatus === 'Occupied') {
        return 'bg-red-300';
      }
      return 'bg-gray-300';
    }

    // Non-pet rooms get regular background colors
    if (housekeepingStatus === 'Clean' && occupancyStatus === 'Vacant') {
      return 'bg-green-200';
    } else if (housekeepingStatus === 'Clean' && occupancyStatus === 'Occupied') {
      return 'bg-blue-200';
    } else if (housekeepingStatus === 'Dirty' && occupancyStatus === 'Vacant') {
      return 'bg-yellow-200';
    } else if (housekeepingStatus === 'Dirty' && occupancyStatus === 'Occupied') {
      return 'bg-red-200';
    }
    return 'bg-gray-200';
  };

  const handleRoomUpdate = async (roomId, updates) => {
    try {
      setLoading(true);
      await api.put(`/room/${roomId}`, updates);
      await fetchRoomData(selectedDate); // Refresh data
      setError(null);
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'An error occurred');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleEditStart = (room) => {
    setEditingRoom(room._id);
    setEditingData({
      pet: room.pet || false,  // Changed from hasPet to pet
      housekeepingStatus: room.housekeepingStatus || '',
      occupancyStatus: room.occupancyStatus || '',
      guestStatus: room.guestStatus || '',
      checkIn: room.checkIn || '',
      checkOut: room.checkOut || '',
      notes: room.notes || '',
      assignedAttendant: room.assignedAttendant || ''
    });
  };

  const handleInputChange = (field, value) => {
    setEditingData(prev => ({
      ...prev,
      [field]: value
    }));
  };

  const handleSave = async (roomId) => {
    try {
      setLoading(true);
      await api.put(`/room/${roomId}`, editingData);
      await fetchRoomData(selectedDate);
      setEditingRoom(null);
      setEditingData({});
      setError(null);
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'An error occurred');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = () => {
    setEditingRoom(null);
    setEditingData({});
  };

  // Import rooms to housekeeping dashboard
  const handleImportToHousekeeping = async () => {
    try {
      setLoading(true);
      await api.post('/room/import-to-housekeeping', {
        date: selectedDate
      });
      setError(null);
      setPopupMessage('Rooms imported to housekeeping dashboard successfully!');
      setPopupType('success');
      setShowPopup(true);
    } catch (err) {
      const errorMessage = err.response?.data?.message || err.message || 'Failed to import to housekeeping dashboard';
      setError(errorMessage);
      setPopupMessage(errorMessage);
      setPopupType('error');
      setShowPopup(true);
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const getFilteredAndSortedRooms = (rooms) => {
    if (!Array.isArray(rooms)) return [];
    
    let filteredRooms = [...rooms];

    // Apply filters
    if (filterBy.status !== 'all') {
      filteredRooms = filteredRooms.filter(room => 
        room.housekeepingStatus.toLowerCase() === filterBy.status
      );
    }

    if (filterBy.occupancy !== 'all') {
      filteredRooms = filteredRooms.filter(room => 
        room.occupancyStatus.toLowerCase() === filterBy.occupancy
      );
    }

    if (filterBy.pet !== 'all') {
      filteredRooms = filteredRooms.filter(room => 
        filterBy.pet === 'yes' ? room.pet : !room.pet
      );
    }

    if (filterBy.dateType !== 'none' && filterBy.dateRange.start) {
      filteredRooms = filteredRooms.filter(room => {
        const date = room[filterBy.dateType];
        return date && date >= filterBy.dateRange.start && 
               (!filterBy.dateRange.end || date <= filterBy.dateRange.end);
      });
    }

    // Apply sorting
    filteredRooms.sort((a, b) => {
      switch (sortBy) {
        case 'room':
          return a.room.localeCompare(b.room, undefined, { numeric: true });
        case 'status':
          return a.housekeepingStatus.localeCompare(b.housekeepingStatus);
        case 'checkIn':
          return (a.checkIn || '').localeCompare(b.checkIn || '');
        case 'checkOut':
          return (a.checkOut || '').localeCompare(b.checkOut || '');
        default:
          return 0;
      }
    });

    return filteredRooms;
  };

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      {/* Beautiful Popup */}
      {showPopup && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl p-6 max-w-md w-full mx-4">
            <div className="flex items-center gap-3 mb-4">
              {popupType === 'success' ? (
                <div className="w-8 h-8 bg-green-100 rounded-full flex items-center justify-center">
                  <svg className="w-5 h-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
                  </svg>
                </div>
              ) : (
                <div className="w-8 h-8 bg-red-100 rounded-full flex items-center justify-center">
                  <svg className="w-5 h-5 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </div>
              )}
              <h3 className={`text-lg font-semibold ${popupType === 'success' ? 'text-green-800' : 'text-red-800'}`}>
                {popupType === 'success' ? 'Success' : 'Error'}
              </h3>
            </div>
            <p className="text-gray-700 mb-6">{popupMessage}</p>
            <button
              onClick={() => setShowPopup(false)}
              className={`w-full py-2 px-4 rounded-lg font-medium transition-colors ${
                popupType === 'success' 
                  ? 'bg-green-600 hover:bg-green-700 text-white' 
                  : 'bg-red-600 hover:bg-red-700 text-white'
              }`}
            >
              OK
            </button>
          </div>
        </div>
      )}

      {/* Import Button - Top Right */}
      <div className="mb-6 flex justify-end">
        <button
          onClick={handleImportToHousekeeping}
          disabled={loading}
          className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:bg-gray-400 transition-colors flex items-center gap-2"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          Import to Housekeeping
        </button>
      </div>

      {/* Header Section */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-800 mb-2">Housekeeping Dashboard</h1>
        <p className="text-gray-600">Manage room status and assignments</p>
      </div>

      {/* Date Selector - Right Aligned */}
      <div className="mb-6 bg-white rounded-xl shadow-sm p-4">
        <div className="flex justify-end items-center gap-4">
          <div className="flex items-center gap-2 text-gray-600">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            <span className="font-medium">Select Date:</span>
          </div>
          
          <div className="flex items-center gap-3">
            <button 
              onClick={() => {
                const prevDate = new Date(selectedDate);
                prevDate.setDate(prevDate.getDate() - 1);
                setSelectedDate(prevDate.toISOString().split('T')[0]);
              }}
              className="p-2 hover:bg-gray-100 rounded-full transition-colors"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            
            <input
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              className="px-4 py-2 border border-gray-300 rounded-lg shadow-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            
            <button 
              onClick={() => {
                const nextDate = new Date(selectedDate);
                nextDate.setDate(nextDate.getDate() + 1);
                setSelectedDate(nextDate.toISOString().split('T')[0]);
              }}
              className="p-2 hover:bg-gray-100 rounded-full transition-colors"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* Filters Section - Enhanced */}
      <div className="mb-6 bg-white rounded-xl shadow-sm overflow-hidden">
        <div className="p-4 border-b border-gray-100">
          <h2 className="text-lg font-semibold text-gray-800">Filters & Sort</h2>
        </div>
        
        <div className="p-4 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Enhanced filter dropdowns */}
            <div className="space-y-1">
              <label className="text-sm font-medium text-gray-700">Sort By</label>
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value)}
                className="w-full rounded-lg border-gray-300 shadow-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              >
                <option value="room">Room Number</option>
                <option value="status">Housekeeping Status</option>
                <option value="checkIn">Check-in Date</option>
                <option value="checkOut">Check-out Date</option>
              </select>
            </div>
            
            {/* Status Filter */}
            <div className="space-y-1">
              <label className="text-sm font-medium text-gray-700">Housekeeping Status</label>
              <select
                value={filterBy.status}
                onChange={(e) => setFilterBy(prev => ({ ...prev, status: e.target.value }))}
                className="w-full rounded-lg border-gray-300 shadow-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              >
                <option value="all">All</option>
                <option value="clean">Clean</option>
                <option value="dirty">Dirty</option>
              </select>
            </div>

            {/* Occupancy Filter */}
            <div className="space-y-1">
              <label className="text-sm font-medium text-gray-700">Occupancy</label>
              <select
                value={filterBy.occupancy}
                onChange={(e) => setFilterBy(prev => ({ ...prev, occupancy: e.target.value }))}
                className="w-full rounded-lg border-gray-300 shadow-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              >
                <option value="all">All</option>
                <option value="occupied">Occupied</option>
                <option value="vacant">Vacant</option>
              </select>
            </div>

            {/* Pet Filter */}
            <div className="space-y-1">
              <label className="text-sm font-medium text-gray-700">Pet Status</label>
              <select
                value={filterBy.pet}
                onChange={(e) => setFilterBy(prev => ({ ...prev, pet: e.target.value }))}
                className="w-full rounded-lg border-gray-300 shadow-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              >
                <option value="all">All Rooms</option>
                <option value="yes">With Pets</option>
                <option value="no">No Pets</option>
              </select>
            </div>
          </div>

          {/* Date Range Filter - Enhanced */}
          <div className="border-t border-gray-100 pt-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Date Filter Type
                </label>
                <select
                  value={filterBy.dateType}
                  onChange={(e) => setFilterBy(prev => ({ 
                    ...prev, 
                    dateType: e.target.value,
                    dateRange: { start: '', end: '' }
                  }))}
                  className="w-full rounded-lg border-gray-300 shadow-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                >
                  <option value="none">No Date Filter</option>
                  <option value="checkIn">Check-in Date</option>
                  <option value="checkOut">Check-out Date</option>
                </select>
              </div>

              {filterBy.dateType !== 'none' && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      From
                    </label>
                    <input
                      type="date"
                      value={filterBy.dateRange.start}
                      onChange={(e) => setFilterBy(prev => ({
                        ...prev,
                        dateRange: { ...prev.dateRange, start: e.target.value }
                      }))}
                      className="w-full rounded-lg border-gray-300 shadow-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      To
                    </label>
                    <input
                      type="date"
                      value={filterBy.dateRange.end}
                      onChange={(e) => setFilterBy(prev => ({
                        ...prev,
                        dateRange: { ...prev.dateRange, end: e.target.value }
                      }))}
                      className="w-full rounded-lg border-gray-300 shadow-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    />
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Loading State - Enhanced */}
      {loading && (
        <div className="flex justify-center items-center h-64">
          <div className="animate-spin rounded-full h-12 w-12 border-4 border-blue-500 border-t-transparent"></div>
        </div>
      )}

      {/* Error State - Enhanced */}
      {error && (
        <div className="bg-red-50 border-l-4 border-red-500 p-4 rounded-lg">
          <div className="flex items-center">
            <svg className="w-6 h-6 text-red-500 mr-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className="text-red-700">{error}</p>
          </div>
        </div>
      )}

      {/* Room Grid - Enhanced */}
      {!loading && !error && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
          {getFilteredAndSortedRooms(rooms.data).map((room) => (
            <div 
              key={room._id}
              className={`relative overflow-hidden rounded-xl shadow-sm hover:shadow-md transition-shadow ${
                getStatusColor(room.housekeepingStatus, room.occupancyStatus, room.pet)
              }`}
            >
              <div className="p-4">
                <div className="flex justify-between items-start mb-3">
                  <h3 className="text-2xl font-bold text-gray-800">Room {room.room}</h3>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleEditStart(room)}
                      className="p-2 hover:bg-gray-100 rounded-full transition-colors"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                      </svg>
                    </button>
                    <span className="px-2 py-1 bg-gray-100 rounded-md text-sm font-medium">
                      {room.type}
                    </span>
                  </div>
                </div>

                {editingRoom === room._id ? (
                  <div className="mt-4 space-y-3 bg-white bg-opacity-75 p-3 rounded">
                    {/* Pet and Dates at the top */}
                    <div className="border-b pb-2 space-y-2">
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={editingData.pet}
                          onChange={(e) => handleInputChange('pet', e.target.checked)}
                          className="rounded text-purple-600 focus:ring-purple-500"
                        />
                        <span className="text-sm font-medium">Pet in Room</span>
                      </label>
                      
                      {editingData.pet && (
                        <div className="grid grid-cols-2 gap-2 mt-2">
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                              Check-in
                            </label>
                            <input
                              type="text"
                              value={editingData.checkIn || ''}
                              onChange={(e) => handleInputChange('checkIn', e.target.value)}
                              placeholder="e.g., May 22"
                              className="w-full text-sm rounded border-gray-300 focus:ring-blue-500 focus:border-blue-500"
                            />
                          </div>
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                              Check-out
                            </label>
                            <input
                              type="text"
                              value={editingData.checkOut || ''}
                              onChange={(e) => handleInputChange('checkOut', e.target.value)}
                              placeholder="e.g., May 25"
                              className="w-full text-sm rounded border-gray-300 focus:ring-blue-500 focus:border-blue-500"
                            />
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Status Selectors */}
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          Housekeeping
                        </label>
                        <select
                          value={editingData.housekeepingStatus}
                          onChange={(e) => handleInputChange('housekeepingStatus', e.target.value)}
                          className="w-full text-sm rounded border-gray-300 focus:ring-blue-500 focus:border-blue-500"
                        >
                          <option value="Clean">Clean</option>
                          <option value="Dirty">Dirty</option>
                        </select>
                      </div>
                      
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          Occupancy
                        </label>
                        <select
                          value={editingData.occupancyStatus}
                          onChange={(e) => handleInputChange('occupancyStatus', e.target.value)}
                          className="w-full text-sm rounded border-gray-300 focus:ring-blue-500 focus:border-blue-500"
                        >
                          <option value="Vacant">Vacant</option>
                          <option value="Occupied">Occupied</option>
                        </select>
                      </div>
                    </div>

                    {/* Guest Status */}
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Guest Status
                      </label>
                      <select
                        value={editingData.guestStatus || ''}
                        onChange={(e) => handleInputChange('guestStatus', e.target.value)}
                        className="w-full text-sm rounded border-gray-300 focus:ring-blue-500 focus:border-blue-500"
                      >
                        <option value="">None</option>
                        <option value="Checked-in">Checked-in</option>
                        <option value="Checked-out">Checked-out</option>
                        <option value="Due-out">Due-out</option>
                      </select>
                    </div>

                    {/* Notes */}
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Notes
                      </label>
                      <textarea
                        value={editingData.notes || ''}
                        onChange={(e) => handleInputChange('notes', e.target.value)}
                        placeholder="Add notes here..."
                        rows="2"
                        className="w-full text-sm rounded border-gray-300 focus:ring-blue-500 focus:border-blue-500"
                      />
                    </div>

                    {/* Assigned Attendant */}
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Assigned Attendant
                      </label>
                      <input
                        type="text"
                        value={editingData.assignedAttendant || ''}
                        onChange={(e) => handleInputChange('assignedAttendant', e.target.value)}
                        placeholder="Enter attendant name"
                        className="w-full text-sm rounded border-gray-300 focus:ring-blue-500 focus:border-blue-500"
                      />
                    </div>

                    {/* Action Buttons */}
                    <div className="flex gap-2 pt-2 border-t">
                      <button
                        onClick={handleCancel}
                        className="flex-1 px-3 py-1 bg-gray-200 rounded hover:bg-gray-300 text-sm font-medium"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={() => handleSave(room._id)}
                        className="flex-1 px-3 py-1 bg-blue-500 text-white rounded hover:bg-blue-600 text-sm font-medium"
                      >
                        Save
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-2 space-y-1">
                    <div className="flex justify-between">
                      <span className="font-medium">Status:</span>
                      <span>{room.housekeepingStatus} / {room.occupancyStatus}</span>
                    </div>

                    {room.guestStatus && (
                      <div className="flex justify-between text-sm">
                        <span>Guest:</span>
                        <span>{room.guestStatus}</span>
                      </div>
                    )}

                    {/* Move pet indicator up and include dates if present */}
                    {room.pet && (
                      <div className="mt-2 text-sm bg-purple-100 p-2 rounded">
                        <div className="font-medium text-purple-700 mb-1">🐾 Pet in Room</div>
                        {(room.checkIn || room.checkOut) && (
                          <div className="text-gray-600 space-y-1">
                            {room.checkIn && <div>Check-in: {room.checkIn}</div>}
                            {room.checkOut && <div>Check-out: {room.checkOut}</div>}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Show dates separately if no pet */}
                    {!room.pet && (room.checkIn || room.checkOut) && (
                      <div className="text-sm bg-gray-50 p-2 rounded mt-2">
                        {room.checkIn && <div>Check-in: {room.checkIn}</div>}
                        {room.checkOut && <div>Check-out: {room.checkOut}</div>}
                      </div>
                    )}

                    {(room.notes || room.description) && (
                      <div className="mt-2 p-2 bg-white bg-opacity-50 rounded text-sm">
                        {room.notes && <p>📝 {room.notes}</p>}
                        {room.description && <p>ℹ️ {room.description}</p>}
                      </div>
                    )}

                    {room.assignedAttendant && (
                      <div className="text-sm mt-2">
                        👤 {room.assignedAttendant}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Legend - Enhanced */}
      <div className="mt-8 bg-white rounded-xl shadow-sm p-4">
        <h3 className="text-sm font-medium text-gray-700 mb-3">Status Legend</h3>
        <div className="flex flex-wrap gap-4">
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 bg-green-200 border border-gray-200"></div>
            <span>Vacant Clean</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 bg-blue-200 border border-gray-200"></div>
            <span>Occupied Clean</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 bg-yellow-200 border border-gray-200"></div>
            <span>Vacant Dirty</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 bg-red-200 border border-gray-200"></div>
            <span>Occupied Dirty</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 bg-gray-200 border-2 border-purple-400"></div>
            <span>Pet in Room</span>
          </div>
        </div>
      </div>
    </div>
  );
}