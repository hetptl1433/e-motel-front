const fs = require('fs');
const path = require('path');

const appRoot = path.join(__dirname, '..');
const webpackFiles = [
  'node_modules/webpack/lib/index.js',
  'node_modules/webpack/lib/webpack.js',
  'node_modules/webpack/lib/WebpackOptionsApply.js',
];

const hookPattern = /\/\* build-hook-start \*\/.*?\/\* build-hook-end \*\//gs;

function stripConsoleNinjaWebpackHooks() {
  let updatedCount = 0;

  for (const relativeFile of webpackFiles) {
    const filePath = path.join(appRoot, relativeFile);

    if (!fs.existsSync(filePath)) {
      continue;
    }

    const source = fs.readFileSync(filePath, 'utf8');
    const cleaned = source.replace(hookPattern, '');

    if (cleaned !== source) {
      fs.writeFileSync(filePath, cleaned, 'utf8');
      updatedCount += 1;
    }
  }

  return updatedCount;
}

if (require.main === module) {
  const updatedCount = stripConsoleNinjaWebpackHooks();

  if (updatedCount > 0) {
    console.log(`Removed Console Ninja webpack hooks from ${updatedCount} file(s).`);
  }
}

module.exports = stripConsoleNinjaWebpackHooks;
