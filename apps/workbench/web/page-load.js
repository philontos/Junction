// One initial loading state per document. Background updates never re-open it.
window.PageLoad = (() => {
  let complete = false;
  const timer = setTimeout(() => error('连接需要一些时间，请检查网络后重试。'), 20000);
  function ready() {
    if (complete) return;
    complete = true; clearTimeout(timer);
    document.body.removeAttribute('data-page-loading');
    const boot = document.getElementById('boot');
    if (boot) { boot.classList.add('done'); boot.setAttribute('aria-hidden', 'true'); boot.inert = true; }
  }
  function error(message) {
    if (complete) return;
    clearTimeout(timer);
    const boot = document.getElementById('boot');
    if (!boot) return;
    const text = document.createElement('p'); text.textContent = message;
    const retry = document.createElement('button'); retry.className = 'sec'; retry.textContent = '重新加载'; retry.onclick = () => location.reload();
    boot.replaceChildren(text, retry);
    const origin = document.querySelector('meta[name="switchyard-cloud-origin"]')?.content;
    if (origin) { const home = document.createElement('a'); home.className = 'sec'; home.href = origin + '/contexts'; home.dataset.themeLink = ''; home.textContent = '返回云端'; boot.append(home); }
  }
  function fade(element) {
    if (!complete || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    element.animate([{ opacity: .45 }, { opacity: 1 }], { duration: 180, easing: 'ease-out' });
  }
  return { ready, error, fade };
})();
