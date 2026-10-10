import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import api from '../api';
import UploadReport from './UploadReport';

jest.mock('../api', () => ({ __esModule: true, default: { post: jest.fn() }, MAX_REPORT_MB: 4, MAX_REPORT_BYTES: 4 * 1024 * 1024 }));

function openUpload() {
  render(<MemoryRouter initialEntries={['/upload-report?date=2026-10-10']}><UploadReport /></MemoryRouter>);
}

function reportFile(size, name = 'morning-report.pdf') {
  const file = new File(['report'], name, { type: 'application/pdf' });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

beforeEach(() => jest.resetAllMocks());

test('hosted uploads show the 4 MB limit and reject oversized files before sending', () => {
  openUpload();
  expect(screen.getByText(/up to 4 MB/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Report file'), { target: { files: [reportFile(4 * 1024 * 1024 + 1)] } });
  expect(screen.getByRole('alert')).toHaveTextContent('Choose a file 4 MB or smaller.');
  expect(screen.getByRole('button', { name: 'Upload PDF' })).toBeDisabled();
  expect(api.post).not.toHaveBeenCalled();
});

test('a file at the hosted limit uploads with the selected report date and clears the size error', async () => {
  api.post.mockResolvedValue({ data: { count: 8 } });
  openUpload();
  const input = screen.getByLabelText('Report file');
  fireEvent.change(input, { target: { files: [reportFile(4 * 1024 * 1024 + 1)] } });
  const file = reportFile(4 * 1024 * 1024);
  fireEvent.change(input, { target: { files: [file] } });
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Upload PDF' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Upload PDF' }));
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
  const [endpoint, formData, options] = api.post.mock.calls[0];
  expect(endpoint).toBe('/room/upload-report');
  expect(formData.get('report')).toBe(file);
  expect(formData.get('reportDate')).toBe('2026-10-10');
  expect(options.timeout).toBe(120000);
  expect(await screen.findByRole('heading', { name: '8 rooms uploaded' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Open front desk' })).toHaveAttribute('href', '/dashboard?date=2026-10-10');
});
