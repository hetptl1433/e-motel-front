import React, { useEffect, useRef, useState } from 'react';
import api from '../api';
import DateSelector, { useReportDate } from './DateSelector';
import { requestError } from '../utils/roomData';

export default function RoomSheets() {
  const [date, setDate] = useReportDate();
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [downloadError, setDownloadError] = useState('');
  const [downloading, setDownloading] = useState(null);
  const [revision, setRevision] = useState(0);
  const objectUrls = useRef(new Set());

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setFiles([]);
    setError('');
    setDownloadError('');
    api.get('/room-sheets', { params: { date }, signal: controller.signal })
      .then(response => {
        if (controller.signal.aborted) return;
        const records = Array.isArray(response.data) ? response.data : response.data?.data;
        if (!Array.isArray(records)) throw new Error('Invalid room sheet list');
        setFiles(records);
      })
      .catch(cause => {
        if (!controller.signal.aborted) setError(requestError(cause, 'Unable to load room sheets. Please try again.'));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [date, revision]);

  useEffect(() => {
    const urls = objectUrls.current;
    return () => { urls.forEach(url => URL.revokeObjectURL(url)); urls.clear(); };
  }, []);

  const downloadSheet = async file => {
    if (downloading) return;
    setDownloading(file.public_id || file.secure_url);
    setDownloadError('');
    try {
      const response = await api.get(file.secure_url, { responseType: 'blob' });
      const url = URL.createObjectURL(response.data);
      objectUrls.current.add(url);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${(file.display_name || `room-sheet-${date}`).replace(/[^a-zA-Z0-9._ -]/g, '_').replace(/\.pdf$/i, '')}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => {
        URL.revokeObjectURL(url);
        objectUrls.current.delete(url);
      }, 1000);
    } catch (cause) {
      setDownloadError(requestError(cause, 'Unable to download this sheet. Please try again.'));
    } finally { setDownloading(null); }
  };

  return (
    <div className="room-page p-4 sm:p-6 max-w-5xl mx-auto">
      <div className="mb-6"><h1 className="text-3xl font-bold text-gray-800">Room Sheets</h1><p className="text-gray-600 mt-1">Download the original report or a sheet with the latest room updates.</p></div>
      <div className="mb-5 bg-white border border-gray-200 p-4 rounded-xl flex flex-wrap items-center justify-between gap-4">
        <DateSelector date={date} onChange={setDate} disabled={Boolean(downloading)} />
        <button type="button" onClick={() => setRevision(value => value + 1)} disabled={loading || Boolean(downloading)} className="px-4 py-2 bg-blue-700 text-white rounded-lg hover:bg-blue-800 disabled:opacity-50">{loading ? 'Loading…' : 'Refresh sheets'}</button>
      </div>
      {error ? <div role="alert" className="mb-4 p-4 bg-red-50 border border-red-200 text-red-800 rounded-lg"><p>{error}</p><button type="button" onClick={() => setRevision(value => value + 1)} className="underline font-medium mt-2">Try again</button></div> : null}
      {downloadError ? <p role="alert" className="mb-4 p-3 bg-red-50 border border-red-200 text-red-800 rounded-lg">{downloadError}</p> : null}
      <div className="bg-white border border-gray-200 rounded-xl p-4 sm:p-6">
        {loading ? <p role="status" className="py-8 text-center text-gray-600">Loading room sheets…</p>
          : error ? null
          : files.length === 0 ? <div className="py-8 text-center"><h2 className="font-semibold text-lg text-gray-800">No room sheets for {date}</h2><p className="text-gray-600 mt-2">Choose another date or upload a room report for this date.</p></div>
          : <><p className="text-sm text-gray-600 mb-4" aria-live="polite">{files.length} {files.length === 1 ? 'sheet' : 'sheets'} available for {date}</p><ul className="divide-y divide-gray-100">{files.map((file, index) => {
            const identifier = file.public_id || `sheet-${index}`;
            const title = file.display_name || String(identifier).split('/').pop().replace(/^room_sheet_/, '');
            const local = typeof file.secure_url === 'string' && /^\/room-sheets\/[^/]+\/(download|generated)$/.test(file.secure_url);
            const external = typeof file.secure_url === 'string' && /^https?:\/\//.test(file.secure_url);
            return <li key={identifier} className="py-4 flex flex-wrap justify-between items-center gap-3"><div className="min-w-0"><h2 className="font-medium text-gray-800 break-words">{title}</h2><p className="text-sm text-gray-500">PDF · {file.kind === 'generated' || /generated/.test(file.secure_url || '') ? 'Includes latest room changes' : 'Original uploaded report'}</p></div>{local ? <button type="button" onClick={() => downloadSheet(file)} disabled={Boolean(downloading)} className="shrink-0 px-4 py-2 rounded-lg bg-blue-50 text-blue-800 font-medium hover:bg-blue-100 disabled:opacity-50">{downloading === (file.public_id || file.secure_url) ? 'Downloading…' : 'Download PDF'}</button>
              : external ? <a href={file.secure_url} target="_blank" rel="noopener noreferrer" className="shrink-0 px-4 py-2 rounded-lg bg-blue-50 text-blue-800 font-medium">View / Download</a>
              : <span className="text-sm text-gray-500">Download unavailable</span>}</li>;
          })}</ul></>}
      </div>
    </div>
  );
}
