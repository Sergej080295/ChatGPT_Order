(() => {
  const STORAGE_KEY = 'plancore_theme';
  const prefersDark = () => window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;

  const getCurrentTheme = () => (document.body.classList.contains('theme-dark') ? 'dark' : 'light');

  const updateToggleLabel = (theme) => {
    const toggleBtn = document.querySelector('[data-action="toggle-theme"]');
    if (!toggleBtn) return;
    toggleBtn.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
    const label = theme === 'dark' ? 'Включён тёмный режим. Переключить на светлый' : 'Включён светлый режим. Переключить на тёмный';
    toggleBtn.setAttribute('aria-label', label);
  };

  const applyTheme = (theme, { save = true } = {}) => {
    const normalized = theme === 'dark' ? 'dark' : 'light';
    document.body.classList.toggle('theme-dark', normalized === 'dark');
    if (save) {
      try {
        localStorage.setItem(STORAGE_KEY, normalized);
      } catch (_err) {
        /* ignore storage errors */
      }
    }
    updateToggleLabel(normalized);
    document.documentElement.style.colorScheme = normalized === 'dark' ? 'dark' : 'light';
    return normalized;
  };

  const resolveInitialTheme = () => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === 'dark' || stored === 'light') {
        return stored;
      }
    } catch (_err) {
      /* ignore storage errors */
    }
    return prefersDark() ? 'dark' : 'light';
  };

  const toggleTheme = () => {
    const next = getCurrentTheme() === 'dark' ? 'light' : 'dark';
    applyTheme(next);
  };

  const initNav = () => {
    const currentSection = document.body.dataset.section;
    if (!currentSection) return;
    document.querySelectorAll('.pc-nav__link').forEach((link) => {
      const section = link.dataset.section;
      link.classList.toggle('pc-nav__link--active', section === currentSection);
    });
  };

  const init = () => {
    const theme = resolveInitialTheme();
    applyTheme(theme, { save: false });
    updateToggleLabel(theme);
    initNav();

    const toggleBtn = document.querySelector('[data-action="toggle-theme"]');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', toggleTheme);
    }

    document.querySelectorAll('[data-animate="fade-in"]').forEach((node) => {
      node.classList.add('pc-kanban-enter');
    });
  };

  document.addEventListener('DOMContentLoaded', init);

  window.PlanCoreTheme = {
    apply: applyTheme,
    get: getCurrentTheme,
    toggle: toggleTheme,
  };

  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY) return;
    if (typeof event.newValue !== 'string') return;
    if (event.newValue === getCurrentTheme()) return;
    applyTheme(event.newValue, { save: false });
  });
})();
