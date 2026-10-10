import axios from 'axios';
import { resolveClientConfig } from './utils/clientConfig';

const configuration = resolveClientConfig({
  NODE_ENV: process.env.NODE_ENV,
  REACT_APP_API_URL: process.env.REACT_APP_API_URL,
  REACT_APP_SOCKET_URL: process.env.REACT_APP_SOCKET_URL,
  REACT_APP_MAX_REPORT_MB: process.env.REACT_APP_MAX_REPORT_MB
}, window.location.origin);
export const SOCKET_URL = configuration.socketURL;
export const SOCKET_OPTIONS = configuration.socketOptions;
export const MAX_REPORT_MB = configuration.maxReportMB;
export const MAX_REPORT_BYTES = configuration.maxReportBytes;
const api = axios.create({ baseURL: configuration.apiURL, timeout: 20000 });

api.interceptors.request.use(config => {
  const token = localStorage.getItem('token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  else delete config.headers.Authorization;
  return config;
});
api.interceptors.response.use(response => response, error => {
  if (error.response?.status === 401 && error.config?.url !== '/auth/login') {
    window.dispatchEvent(new Event('session-expired'));
  }
  return Promise.reject(error);
});
export default api;
