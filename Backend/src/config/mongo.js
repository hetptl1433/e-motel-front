const dns = require('dns').promises;

const MONGO_ENV_KEYS = ['MONGODB_URI', 'MONGO_URI'];

function getMongoConfig() {
  for (const envKey of MONGO_ENV_KEYS) {
    const rawValue = process.env[envKey];
    if (typeof rawValue === 'string' && rawValue.trim()) {
      const uri = rawValue.trim();
      return {
        envKey,
        uri,
        warnings: buildWarnings(uri, envKey)
      };
    }
  }

  return {
    envKey: null,
    uri: '',
    warnings: []
  };
}

function buildWarnings(uri, envKey) {
  const warnings = [];

  if (envKey === 'MONGO_URI' && !process.env.MONGODB_URI) {
    warnings.push('Using legacy MONGO_URI. Rename it to MONGODB_URI to match the server configuration.');
  }

  if (uri.includes('/YourDBName')) {
    warnings.push('MongoDB URI still contains the placeholder database name "YourDBName". Replace it with your actual database name.');
  }

  return warnings;
}

function getMongoConfigError(config = getMongoConfig()) {
  if (!config.uri) {
    return 'MongoDB URI is missing. Set MONGODB_URI in .env.';
  }

  if (!/^mongodb(\+srv)?:\/\//.test(config.uri)) {
    return `MongoDB URI from ${config.envKey} must start with mongodb:// or mongodb+srv://.`;
  }

  return null;
}

async function getMongoPreflightError(config = getMongoConfig()) {
  const configError = getMongoConfigError(config);
  if (configError) {
    return configError;
  }

  // Standard URIs may contain several replica-set hosts; URL does not support
  // that syntax. Let the MongoDB driver validate non-SRV connection strings.
  if (config.uri.startsWith('mongodb://')) return null;

  let parsed;

  try {
    parsed = new URL(config.uri);
  } catch {
    return `MongoDB URI from ${config.envKey} is not a valid connection string.`;
  }

  if (parsed.protocol !== 'mongodb+srv:') {
    return null;
  }

  const srvRecord = `_mongodb._tcp.${parsed.hostname}`;

  try {
    const records = await dns.resolveSrv(srvRecord);
    if (!records.length) {
      return `MongoDB SRV lookup returned no records for ${parsed.hostname}. Verify the Atlas connection string in ${config.envKey}.`;
    }
  } catch (error) {
    if (error.code === 'ENOTFOUND' || error.code === 'ENODATA') {
      return `MongoDB Atlas hostname "${parsed.hostname}" does not resolve. Update ${config.envKey} with the current connection string from MongoDB Atlas.`;
    }

    if (error.code === 'ECONNREFUSED' || error.code === 'EAI_AGAIN' || error.code === 'ETIMEOUT') {
      return `MongoDB SRV lookup could not reach DNS while resolving ${parsed.hostname}. Check your network/DNS settings, or confirm the Atlas hostname in ${config.envKey} is correct.`;
    }

    return `MongoDB SRV lookup failed for ${parsed.hostname}: ${error.message}`;
  }

  return null;
}

module.exports = {
  getMongoConfig,
  getMongoConfigError,
  getMongoPreflightError
};
