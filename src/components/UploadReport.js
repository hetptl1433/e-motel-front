import React, { useState } from 'react';
import api from '../api';

export default function UploadReport() {
  const [file, setFile] = useState(null);
  const [reportDate, setReportDate] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [progress, setProgress] = useState('');

  const updateProgress = (status) => {
    setProgress(status);
  };

  const handleFileChange = (e) => {
    setFile(e.target.files[0]);
    setMessage('');
    setError('');
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!file || !reportDate) {
      setError('Please select both a PDF file and report date.');
      return;
    }

    setIsLoading(true);
    setError('');
    setMessage('');
    
    const formData = new FormData();
    formData.append('report', file);
    formData.append('reportDate', reportDate);

    try {
      updateProgress('Uploading file...');
      const res = await api.post('/room/upload-report', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
        onUploadProgress: (progressEvent) => {
          const percentCompleted = Math.round((progressEvent.loaded * 100) / progressEvent.total);
          updateProgress(`Uploading file: ${percentCompleted}%`);
        },
      });
      
      setMessage(res.data.message || 'Upload successful');
      setFile(null);
      setReportDate('');
      e.target.reset();
    } catch (err) {
      setError(err.response?.data?.message || 'Upload failed');
    } finally {
      setIsLoading(false);
      setProgress('');
    }
  };

  return (
    <div className="p-6 max-w-md mx-auto">
      <h1 className="text-2xl font-semibold mb-4">Upload Room Status Report (PDF)</h1>
      
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="reportDate" className="block text-sm font-medium text-gray-700 mb-1">
            Report Date
          </label>
          <input
            type="date"
            id="reportDate"
            value={reportDate}
            onChange={(e) => setReportDate(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
            required
          />
        </div>
        
        <div>
          <label htmlFor="reportFile" className="block text-sm font-medium text-gray-700 mb-1">
            PDF File
          </label>
          <input
            id="reportFile"
            type="file"
            accept="application/pdf"
            onChange={handleFileChange}
            className="w-full"
            required
          />
        </div>

        <button
          type="submit"
          disabled={isLoading}
          className={`w-full px-4 py-2 text-white rounded focus:outline-none focus:ring-2 focus:ring-offset-2 ${
            isLoading ? 'bg-blue-400 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-700'
          }`}
        >
          {isLoading ? 'Processing...' : 'Upload Report'}
        </button>
      </form>

      {isLoading && (
        <div className="mt-4">
          <div className="animate-pulse flex space-x-4 items-center justify-center p-4 bg-blue-50 rounded">
            <div className="w-6 h-6 border-t-2 border-b-2 border-blue-500 rounded-full animate-spin"></div>
            <div className="text-blue-600">
              {progress || 'Processing your report. This may take a few minutes...'}
            </div>
          </div>
        </div>
      )}
      
      {message && (
        <div className="mt-4 p-3 bg-green-100 border border-green-400 text-green-700 rounded">
          {message}
        </div>
      )}
      
      {error && (
        <div className="mt-4 p-3 bg-red-100 border border-red-400 text-red-700 rounded">
          {error}
        </div>
      )}
    </div>
  );
}