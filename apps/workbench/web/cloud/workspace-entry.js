import { devicePath, localDevice } from './device-routing.js';
import { discoverLocalDevice } from './local-discovery.js';
import { contextReference, withContext } from './context-link.js';

const workspace = document.getElementById('cloud-device-switcher');
try {
  if (workspace?.dataset.mode !== 'local' && !localDevice(workspace?.dataset.userId)) {
    const response = await fetch('/hub/devices', { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('无法读取设备列表，请重新登录工作台。');
    const { items } = await response.json();
    const discovery = await discoverLocalDevice(workspace.dataset.userId, items);
    if (discovery.blocked) throw new Error('无法识别本机，请允许浏览器访问本地网络后重新加载。');
  }
  if (workspace?.dataset.mode !== 'local' && localDevice(workspace?.dataset.userId)?.device === workspace?.dataset.deviceId) {
    // Resolve the device before importing the app: a bookmarked cloud URL must
    // never briefly render or attach a relayed terminal for this computer.
    const params = new URLSearchParams(location.search);
    location.replace(Theme.url(withContext(devicePath(workspace.dataset.deviceId, workspace.dataset.userId, params.get('task')), contextReference(params))));
  } else {
    await import('../js/main.js');
  }
} catch (error) { window.PageLoad.error(error.message || '页面加载失败，请重试。'); }
