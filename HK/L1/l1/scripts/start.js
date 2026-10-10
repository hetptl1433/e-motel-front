const { spawn } = require('child_process');

const stripConsoleNinjaWebpackHooks = require('./stripConsoleNinjaWebpackHooks');

function createCleanEnv() {
  const env = { ...process.env, HOST: '127.0.0.1' };

  for (const key of Object.keys(env)) {
    if (key.startsWith('VSCODE_') || key.startsWith('NINJA_')) {
      delete env[key];
    }
  }

  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

stripConsoleNinjaWebpackHooks();

const child = spawn(process.execPath, [require.resolve('react-scripts/scripts/start')], {
  stdio: 'inherit',
  env: createCleanEnv(),
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => child.kill(signal));
}

child.on('exit', code => {
  process.exit(code ?? 0);
});
