import { devicePath, localDevice } from './device-routing.js';

const workspace = document.getElementById('cloud-device-switcher');
if (workspace?.dataset.mode !== 'local' && localDevice(workspace?.dataset.userId)?.device === workspace?.dataset.deviceId) {
  // Resolve the device before importing the app: a bookmarked cloud URL must
  // never briefly render or attach a relayed terminal for this computer.
  location.replace(devicePath(workspace.dataset.deviceId, workspace.dataset.userId, new URLSearchParams(location.search).get('task')));
} else {
  import('../js/main.js').catch(() => window.PageLoad.error('页面加载失败，请重试。'));
}
