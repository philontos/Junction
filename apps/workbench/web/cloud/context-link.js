// A pinned Context reference is navigation data, never permission to run a task.
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
export function contextReference(params) {
  const context = params?.get('context'), revision = params?.get('revision');
  return uuid(context) && uuid(revision) ? { context, revision } : null;
}
export function withContext(path, reference) {
  if (!reference || !uuid(reference.context) || !uuid(reference.revision)) return path;
  const url = new URL(path, 'http://navigation.invalid');
  url.searchParams.set('context', reference.context);
  url.searchParams.set('revision', reference.revision);
  return path.startsWith('/') ? url.pathname + url.search + url.hash : url.href;
}
export function withView(path, view) {
  if (view !== 'contexts') return path;
  const url = new URL(path, 'http://navigation.invalid'); url.searchParams.set('view', view);
  return path.startsWith('/') ? url.pathname + url.search + url.hash : url.href;
}
export function safeWorkspaceReturn(value) {
  if (typeof value !== 'string') return null;
  const [pathname, query = ''] = value.split('?');
  if (!/^\/(?:local\/open\/[0-9a-f-]{36}|workspace\/[0-9a-f-]{36}\/)$/i.test(pathname)) return null;
  const params = new URLSearchParams(query);
  if ([...params.keys()].some(key => !['task', 'context', 'revision', 'view'].includes(key))) return null;
  if (params.has('view') && params.get('view') !== 'contexts') return null;
  const task = params.get('task');
  if (task !== null && !/^(?:[1-9]\d*|n[1-9]\d*:[1-9]\d*)$/.test(task)) return null;
  if ((params.has('context') || params.has('revision')) && !contextReference(params)) return null;
  return pathname + (params.size ? '?' + params.toString() : '');
}
