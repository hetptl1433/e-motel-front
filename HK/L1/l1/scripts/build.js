const { spawnSync } = require('child_process');

const stripConsoleNinjaWebpackHooks = require('./stripConsoleNinjaWebpackHooks');

function createCleanEnv() {
  const env = { ...process.env };

  for (const key of Object.keys(env)) {
    if (key.startsWith('VSCODE_') || key.startsWith('NINJA_')) {
      delete env[key];
    }
  }

  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

stripConsoleNinjaWebpackHooks();

const result = spawnSync(
  process.execPath,
  [require.resolve('react-scripts/scripts/build')],
  {
    stdio: 'inherit',
    env: createCleanEnv(),
  }
);

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 0);
