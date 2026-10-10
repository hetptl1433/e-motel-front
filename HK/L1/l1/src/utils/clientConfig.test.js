import { resolveClientConfig } from './clientConfig';

const origin = 'https://motel.vercel.app';

test('production uses same-origin API and direct WebSocket transport without endpoint variables', () => {
  const config = resolveClientConfig({ NODE_ENV: 'production' }, origin);
  expect(config.apiURL).toBe('/api');
  expect(config.socketURL).toBe(origin);
  expect(config.socketOptions).toEqual({ path: '/socket.io', transports: ['websocket'] });
  expect(config.maxReportBytes).toBe(4 * 1024 * 1024);
});

test('development keeps the local API, polling upgrade, and 10 MB report limit', () => {
  const config = resolveClientConfig({ NODE_ENV: 'development' }, 'http://localhost:3000');
  expect(config.apiURL).toBe('http://localhost:4000/api');
  expect(config.socketURL).toBe('http://localhost:4000');
  expect(config.socketOptions.transports).toEqual(['polling', 'websocket']);
  expect(config.maxReportBytes).toBe(10 * 1024 * 1024);
});

test('remote API configuration is normalized and its origin supplies the socket default', () => {
  const config = resolveClientConfig({ NODE_ENV: 'production', REACT_APP_API_URL: ' https://backend.example.com/api/// ' }, origin);
  expect(config.apiURL).toBe('https://backend.example.com/api');
  expect(config.socketURL).toBe('https://backend.example.com');
});

test('an explicit remote socket URL is honored independently of the API', () => {
  const config = resolveClientConfig({ NODE_ENV: 'production', REACT_APP_API_URL: '/api/', REACT_APP_SOCKET_URL: 'wss://live.example.com/' }, origin);
  expect(config.apiURL).toBe('/api');
  expect(config.socketURL).toBe('wss://live.example.com');
});

test.each(['http://localhost:4000', 'http://127.0.0.1:4000', 'http://[::1]:4000', '//api.localhost:4000', 'http://0.0.0.0:4000'])('production ignores accidental local endpoints: %s', endpoint => {
  const config = resolveClientConfig({ NODE_ENV: 'production', REACT_APP_API_URL: `${endpoint}/api`, REACT_APP_SOCKET_URL: endpoint }, origin);
  expect(config.apiURL).toBe('/api');
  expect(config.socketURL).toBe(origin);
});

test('explicit local endpoint overrides remain available for development', () => {
  const config = resolveClientConfig({ NODE_ENV: 'development', REACT_APP_API_URL: 'http://127.0.0.1:4400/api', REACT_APP_SOCKET_URL: 'http://127.0.0.1:4400' }, origin);
  expect(config.apiURL).toBe('http://127.0.0.1:4400/api');
  expect(config.socketURL).toBe('http://127.0.0.1:4400');
});

test('invalid endpoint schemes use working defaults', () => {
  const config = resolveClientConfig({ NODE_ENV: 'production', REACT_APP_API_URL: 'ftp://backend.example.com/api', REACT_APP_SOCKET_URL: 'file:///socket.io' }, origin);
  expect(config.apiURL).toBe('/api');
  expect(config.socketURL).toBe(origin);
});

test('report limits can be reduced while the hosted cap stays below the platform request limit', () => {
  expect(resolveClientConfig({ NODE_ENV: 'production', REACT_APP_MAX_REPORT_MB: '2' }, origin).maxReportMB).toBe(2);
  expect(resolveClientConfig({ NODE_ENV: 'production', REACT_APP_MAX_REPORT_MB: '10' }, origin).maxReportMB).toBe(4);
  expect(resolveClientConfig({ NODE_ENV: 'development', REACT_APP_MAX_REPORT_MB: '4' }, origin).maxReportMB).toBe(4);
  for (const limit of ['0', '-2', 'invalid']) {
    expect(resolveClientConfig({ NODE_ENV: 'production', REACT_APP_MAX_REPORT_MB: limit }, origin).maxReportMB).toBe(4);
  }
});
