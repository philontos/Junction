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
  html = html.replace('<body data-page-loading>', '<body class="cloud-workspace" data-page-loading>');
  html = html.replace('class="brand" href="/"', `class="brand" href="${escapeHtml(cloudOrigin)}/"`);
  html = html.replace('id="junction-nav" href="/contexts"', `id="junction-nav" href="${escapeHtml(cloudOrigin)}/contexts" data-cloud-context="true"`);
  html = html.replace('id="workbench-nav" href="/"', `id="workbench-nav" href="${local ? '/' : '/workspace/' + deviceId + '/'}"`);
  html = html.replace('<span style="flex:1"></span>', `<span style="flex:1"></span><details id="cloud-device-switcher" class="cloud-switcher" data-mode="${local ? 'local' : 'relay'}" data-device-id="${deviceId}" data-device-name="${escapeHtml(deviceName)}" data-user-id="${escapeHtml(userId)}"><summary class="cloud-current" aria-label="切换设备"><span class="cloud-dot${local ? ' online' : ''}" id="cloud-current-dot"></span><span class="cloud-current-name">${escapeHtml(deviceName)}</span><span id="cloud-current-ssh" hidden></span><span class="cloud-caret" aria-hidden="true"></span></summary></details>`);
  html = html.replace('src="/js/main.js"', 'src="/cloud/workspace-entry.js"');
  return html;
}

export function localEntryHtml(root: string, cloudOrigin: string, deviceId: string, mode: 'cloud' | 'local' | 'confirm' = 'cloud') {
  return fs.readFileSync(path.join(root, 'web/cloud/local-entry.html'), 'utf8')
    .replace('__ENTRY_MODE__', mode)
    .replaceAll('__CLOUD_ORIGIN__', escapeHtml(cloudOrigin))
    .replaceAll('__DEVICE_ID__', escapeHtml(deviceId));
}
