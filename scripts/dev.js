const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const apps = [
  { name: 'Backend', cwd: path.join(root, 'Backend'), script: 'node_modules/nodemon/bin/nodemon.js', args: ['--exitcrash', 'server.js'] },
  { name: 'Frontend', cwd: path.join(root, 'HK/L1/l1'), script: 'scripts/start.js', args: [] }
];
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  children.forEach(child => { if (child.exitCode === null) child.kill('SIGTERM'); });
}
for (const app of apps) {
  if (!fs.existsSync(path.join(app.cwd, 'node_modules'))) {
    console.error(`Install dependencies first: npm --prefix ${path.relative(root, app.cwd)} install`);
    stop(1);
    break;
  }
  const script = path.join(app.cwd, app.script);
  // Production-style dependency installs omit nodemon. Supported Node versions
  // can still watch the backend so the documented local command remains usable.
  const args = app.name === 'Backend' && !fs.existsSync(script)
    ? ['--watch', path.join(app.cwd, 'server.js')]
    : [script, ...app.args];
  const child = spawn(process.execPath, args, {
    cwd: app.cwd, stdio: 'inherit', env: { ...process.env, BROWSER: 'none' }
  });
  children.push(child);
  child.once('error', error => { console.error(`${app.name}: ${error.message}`); stop(1); });
  child.once('exit', code => { if (!stopping) stop(code || 0); });
}
process.once('SIGINT', () => stop());
process.once('SIGTERM', () => stop());
