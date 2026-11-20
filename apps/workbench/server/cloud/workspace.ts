import fs from 'node:fs';
import path from 'node:path';

export const escapeHtml = (text: string) => text.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export interface WorkspaceIdentity { deviceId: string; deviceName: string; userId: string; cloudOrigin: string; local?: boolean }

/** The same workbench and assets are served by the cloud and the local node. */
export function workspaceHtml(root: string, identity: WorkspaceIdentity) {
  const { deviceId, deviceName, userId, cloudOrigin, local = false } = identity;
  let html = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8');
  const prefix = local ? '' : '/nodes/' + deviceId;
  html = html.replace('<head>', `<head><meta name="switchyard-base" content="${prefix}"><meta name="switchyard-cloud-origin" content="${escapeHtml(cloudOrigin)}"><link rel="stylesheet" href="/cloud/workspace.css">`);
  html = html.replace('<body>', '<body class="cloud-workspace">');
  const returnLink = `<a id="workspace-cloud-return" class="sec workspace-local-open" href="${escapeHtml(cloudOrigin)}/workspace/${deviceId}/" data-i18n="workspace.returnCloud">返回云端</a>`;
  html = html.replace('<span style="flex:1"></span>', `<span style="flex:1"></span><span id="workspace-transport" class="workspace-transport${local ? ' local' : ''}" data-i18n="workspace.${local ? 'direct' : 'relay'}">${local ? '本机直连' : '云端中转'}</span>${local ? '' : `<a id="workspace-local-open" class="sec workspace-local-open" href="/local/open/${deviceId}" data-i18n="workspace.openLocal">本机打开</a>`}<details id="cloud-device-switcher" class="cloud-switcher" data-mode="${local ? 'local' : 'relay'}" data-device-id="${deviceId}" data-device-name="${escapeHtml(deviceName)}" data-user-id="${escapeHtml(userId)}"><summary class="cloud-current" aria-label="切换设备"><span class="cloud-dot${local ? ' online' : ''}" id="cloud-current-dot"></span><span class="cloud-current-name">${escapeHtml(deviceName)}</span><span id="cloud-current-ssh" hidden></span><span class="cloud-caret" aria-hidden="true"></span></summary></details>`);
  if (local) html = html.replace('<details id="cloud-device-switcher"', returnLink + '<details id="cloud-device-switcher"');
  return html;
}

export function localEntryHtml(root: string, cloudOrigin: string, deviceId: string, local = false) {
  return fs.readFileSync(path.join(root, 'web/cloud/local-entry.html'), 'utf8')
    .replace('__ENTRY_MODE__', local ? 'local' : 'cloud')
    .replaceAll('__CLOUD_ORIGIN__', escapeHtml(cloudOrigin))
    .replaceAll('__DEVICE_ID__', escapeHtml(deviceId));
}
