import React, { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api, { MAX_REPORT_BYTES, MAX_REPORT_MB } from '../api';
import { requestError } from '../utils/roomData';
import { useReportDate } from './DateSelector';

export default function UploadReport() {
  const [file, setFile] = useState(null);
  const [reportDate, setReportDate] = useReportDate();
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const fileInput = useRef(null);
  const warnings = Array.isArray(result?.warnings) ? result.warnings : [];

  const handleFileChange = event => {
    const selected = event.target.files[0];
    setResult(null);
    setError('');
    setFile(null);
    if (!selected) return;
    if (!/\.(pdf|csv|json)$/i.test(selected.name)) {
      setError('Choose a Super 8 PDF, CSV, or JSON room report.');
      event.target.value = '';
      return;
    }
    if (selected.size > MAX_REPORT_BYTES) {
      setError(`Choose a file ${MAX_REPORT_MB} MB or smaller.`);
      event.target.value = '';
      return;
    }
    setFile(selected);
  };

  const handleSubmit = async event => {
    event.preventDefault();
    if (busy) return;
    if (!file || !reportDate) { setError('Choose a report file and report date.'); return; }
    setBusy(true);
    setError('');
    setResult(null);
    setProgress('Uploading PDF…');
    const formData = new FormData();
    formData.append('report', file);
    formData.append('reportDate', reportDate);
    try {
      const response = await api.post('/room/upload-report', formData, {
        timeout: 120000,
        onUploadProgress: event => {
          if (event.total && event.loaded < event.total) {
            setProgress(`Uploading: ${Math.round(event.loaded / event.total * 100)}%`);
          } else setProgress('Reading the report and preparing the room boards…');
        }
      });
      setResult({ ...response.data, date: reportDate });
      setFile(null);
      if (fileInput.current) fileInput.current.value = '';
    } catch (failure) {
      setError(requestError(failure, 'The report could not be uploaded. Please try again.'));
    } finally {
      setBusy(false);
      setProgress('');
    }
  };

  return (
    <div className="max-w-2xl mx-auto p-4 sm:p-8">
      <h1 className="text-3xl font-bold text-gray-800 mb-2">Upload PDF</h1>
      <p className="text-gray-600 mb-6">Upload the morning Super 8 room-status PDF. Rooms appear on the front desk and housekeeping boards automatically.</p>
      <form onSubmit={handleSubmit} className="bg-white border border-gray-200 rounded-xl p-5 sm:p-6 space-y-5">
        <div>
          <label htmlFor="reportDate" className="block text-sm font-medium text-gray-700 mb-2">Report date</label>
          <input type="date" id="reportDate" value={reportDate} onChange={event => setReportDate(event.target.value)}
            disabled={busy} className="w-full px-3 py-2 border border-gray-300 rounded-lg" required />
          <p className="mt-2 text-sm text-gray-500">Use the date printed on the report. Uploading it again preserves staff’s cleaning progress.</p>
        </div>
        <div>
          <label htmlFor="reportFile" className="block text-sm font-medium text-gray-700 mb-2">Report file</label>
          <input ref={fileInput} id="reportFile" type="file" accept=".pdf,.csv,.json,application/pdf,text/csv,application/json"
            onChange={handleFileChange} disabled={busy} className="block w-full text-sm" required />
          <p className="mt-2 text-sm text-gray-500">Super 8 PDF with selectable text, CSV, or JSON · up to {MAX_REPORT_MB} MB.</p>
          {file && <p className="mt-2 text-sm text-gray-700">{file.name} · {(file.size / 1024).toFixed(0)} KB</p>}
        </div>
        {error && <div role="alert" className="p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg">{error}</div>}
        <button type="submit" disabled={busy || !file || !reportDate}
          className="w-full px-4 py-3 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg disabled:opacity-50 disabled:cursor-not-allowed">
          {busy ? 'Uploading…' : 'Upload PDF'}
        </button>
        {busy && <p role="status" className="text-center text-sm text-blue-700">{progress}</p>}
      </form>
      {result && (
        <div role="status" className={`mt-6 p-5 border rounded-xl ${warnings.length ? 'bg-amber-50 border-amber-200 text-amber-900' : 'bg-green-50 border-green-200 text-green-900'}`}>
          <h2 className="text-lg font-semibold">{result.count} rooms uploaded</h2>
          <p className="mt-1">{warnings.length ? `The room report for ${result.date} was saved. Check the message below before using the boards.` : `The front desk and housekeeping boards for ${result.date} are ready.`}</p>
          {!warnings.length && <p className="mt-2 text-sm">Existing cleaning progress is preserved.</p>}
          {warnings.length > 0 && <div role="alert" className="mt-3 space-y-2">
            {warnings.map((warning, index) => <p key={`${index}-${warning}`}>{warning}</p>)}
          </div>}
          <div className="flex flex-wrap gap-4 mt-4">
            <Link className="font-medium underline" to={`/dashboard?date=${result.date}`}>Open front desk</Link>
            <Link className="font-medium underline" to={`/housekeeping?date=${result.date}`}>Open housekeeping</Link>
          </div>
        </div>
      )}
      <div className="mt-6 p-4 text-sm text-gray-600">
        <p>Use the original exported PDF. Scanned images and different report layouts cannot be parsed by this importer.</p>
      </div>
    </div>
  );
}
