import { spawn } from 'node:child_process';

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const electronCmd = process.platform === 'win32' ? 'node_modules\\.bin\\electron.cmd' : 'node_modules/.bin/electron';
const vite = spawn(npmCmd, ['run', 'dev:web'], { stdio: 'inherit', shell: false });
let electron;

const timer = setInterval(async () => {
  try {
    const response = await fetch('http://127.0.0.1:5173');
    if (!response.ok) return;
    clearInterval(timer);
    electron = spawn(electronCmd, ['.'], { stdio: 'inherit', env: { ...process.env, VITE_DEV_SERVER_URL: 'http://127.0.0.1:5173' }, shell: false });
    electron.on('exit', () => vite.kill('SIGTERM'));
  } catch {}
}, 250);

process.on('SIGINT', () => { clearInterval(timer); electron?.kill('SIGTERM'); vite.kill('SIGTERM'); });
