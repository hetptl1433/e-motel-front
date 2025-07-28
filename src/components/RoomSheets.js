import React, { useState } from 'react';

export default function RoomSheets() {
  const [files, setFiles]     = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);
  const [date, setDate]       = useState('');

  const fetchFiles = async () => {
    if (!date) return setError('Please pick a date');
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(
        `http://localhost:4000/api/room-sheets?date=${date}`
      );
      if (!res.ok) throw new Error((await res.json()).error || res.statusText);
      const data = await res.json();
      setFiles(data);
    } catch (err) {
      setError(err.message);
      setFiles([]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <h1 className="text-3xl font-semibold mb-6 text-center">Room Sheets</h1>

      <div className="mb-4 flex gap-4 items-center">
        <input
          type="date"
          value={date}
          onChange={e => setDate(e.target.value)}
          className="border rounded px-3 py-2"
        />
        <button
          onClick={fetchFiles}
          disabled={loading}
          className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? 'Loading…' : 'Fetch Sheets'}
        </button>
      </div>

      {error && <div className="text-red-600 mb-4">{error}</div>}

      <div className="bg-white rounded shadow p-4">
        {files.length === 0 && !loading && <div>No files found.</div>}
        <ul>
          {files.map(file => (
            <li
              key={file.public_id}
              className="mb-2 flex justify-between items-center"
            >
              <span>
                {file.public_id.split('/').pop().replace('room_sheet_', '')}
              </span>
              <a
                href={file.secure_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 underline"
              >
                View/Download
              </a>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
