const { spawnSync } = require('child_process');
const path = require('path');
const root = path.resolve(__dirname, '..');
const backend = spawnSync(process.execPath, ['--test'], { cwd: path.join(root, 'Backend'), stdio: 'inherit' });
if (backend.status !== 0) process.exit(backend.status || 1);
const frontend = spawnSync(process.execPath, ['node_modules/react-scripts/scripts/test.js', '--watchAll=false', '--runInBand'], {
  cwd: path.join(root, 'HK/L1/l1'), stdio: 'inherit', env: { ...process.env, CI: 'true' }
});
if (frontend.error) console.error(frontend.error.message);
process.exit(frontend.status === 0 ? 0 : frontend.status || 1);
