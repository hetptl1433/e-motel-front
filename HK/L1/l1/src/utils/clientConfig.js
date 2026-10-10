function endpoint(value, origin, production, protocols) {
  const candidate = typeof value === 'string' ? value.trim() : '';
  if (!candidate) return '';
  try {
    const url = new URL(candidate, origin);
    if (!protocols.includes(url.protocol)) return '';
    const absolute = /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(candidate);
    const loopback = url.hostname === 'localhost' || url.hostname.endsWith('.localhost')
      || /^127\./.test(url.hostname) || ['[::1]', '0.0.0.0'].includes(url.hostname);
    if (production && absolute && loopback) return '';
    return candidate.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

export function resolveClientConfig(environment, origin) {
  const production = environment.NODE_ENV === 'production';
  const apiURL = endpoint(environment.REACT_APP_API_URL, origin, production, ['http:', 'https:'])
    || (production ? '/api' : 'http://localhost:4000/api');
  const socketURL = endpoint(environment.REACT_APP_SOCKET_URL, origin, production, ['http:', 'https:', 'ws:', 'wss:'])
    || new URL(apiURL, origin).origin;
  const defaultLimit = production ? 4 : 10;
  const configuredLimit = Number(environment.REACT_APP_MAX_REPORT_MB);
  const maxReportMB = Number.isFinite(configuredLimit) && configuredLimit > 0
    ? Math.min(configuredLimit, defaultLimit) : defaultLimit;

  return {
    apiURL,
    socketURL,
    socketOptions: { path: '/socket.io', transports: production ? ['websocket'] : ['polling', 'websocket'] },
    maxReportMB,
    maxReportBytes: Math.floor(maxReportMB * 1024 * 1024)
  };
}
