(function () {
  const nav = document.getElementById('global-nav');
  if (!nav) return;
  const here = location.pathname.split('/').pop() || 'index.html';
  const links = [
    { href: 'index.html',    label: '⚡ IMS Dashboard' },
    { href: 'policies.html', label: '📋 Policies & Protocols' },
  ];
  nav.innerHTML = `
    <div class="nav-inner">
      <span class="nav-brand">IMS<span class="nav-brand-dot">·</span>meta-scheduler</span>
      <nav class="nav-links">
        ${links.map(l => `
          <a href="${l.href}" class="nav-link${here === l.href ? ' nav-active' : ''}">${l.label}</a>
        `).join('')}
      </nav>
    </div>`;
})();
