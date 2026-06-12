(() => {
  const STORAGE_KEY = 'plancore_theme';
  const PLANECORE_VERSION = '5.8.2';
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

  const ensureVersionBadge = () => {
    let badge = document.querySelector('.pc-version-badge');
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'pc-version-badge';
      badge.setAttribute('aria-hidden', 'true');
      document.body.appendChild(badge);
    }
    badge.textContent = `v${PLANECORE_VERSION}`;
  };

  let navTooltipEl = null;
  let navTooltipTitle = null;
  let navTooltipDesc = null;

  const ensureNavTooltip = () => {
    if (navTooltipEl) return navTooltipEl;
    navTooltipEl = document.createElement('div');
    navTooltipEl.className = 'pc-nav__tooltip';
    navTooltipTitle = document.createElement('div');
    navTooltipTitle.className = 'pc-nav__tooltip-title';
    navTooltipDesc = document.createElement('div');
    navTooltipDesc.className = 'pc-nav__tooltip-desc';
    navTooltipEl.append(navTooltipTitle, navTooltipDesc);
    document.body.appendChild(navTooltipEl);
    return navTooltipEl;
  };

  const hideNavTooltip = () => {
    if (!navTooltipEl) return;
    navTooltipEl.classList.remove('is-visible');
  };

  const positionNavTooltip = (target) => {
    if (!navTooltipEl || !target) return;
    const rect = target.getBoundingClientRect();
    const spacing = 10;
    const viewportWidth = document.documentElement.clientWidth;
    const tooltipWidth = navTooltipEl.offsetWidth || 0;
    const preferredLeft = rect.left + rect.width / 2 - tooltipWidth / 2;
    const clampedLeft = Math.min(Math.max(preferredLeft, 8), viewportWidth - tooltipWidth - 8);
    const top = rect.bottom + spacing + window.scrollY;
    navTooltipEl.style.left = `${clampedLeft + window.scrollX}px`;
    navTooltipEl.style.top = `${top}px`;
    navTooltipEl.style.transformOrigin = 'top center';
  };

  const showNavTooltip = (target) => {
    if (!target) return;
    const primary = target.dataset.tooltipPrimary;
    if (!primary) return;
    const tooltip = ensureNavTooltip();
    navTooltipTitle.textContent = primary;
    const secondary = target.dataset.tooltipSecondary || '';
    navTooltipDesc.textContent = secondary;
    navTooltipDesc.hidden = !secondary;
    tooltip.style.visibility = 'hidden';
    tooltip.classList.add('is-visible');
    requestAnimationFrame(() => {
      positionNavTooltip(target);
      tooltip.style.visibility = 'visible';
    });
  };

  const bindNavTooltips = () => {
    const links = document.querySelectorAll('.pc-nav__link[data-tooltip-primary]');
    if (!links.length) return;
    links.forEach((link) => {
      const show = () => showNavTooltip(link);
      const hide = () => hideNavTooltip();
      link.addEventListener('mouseenter', show);
      link.addEventListener('focus', show);
      link.addEventListener('mouseleave', hide);
      link.addEventListener('blur', hide);
    });
    window.addEventListener('scroll', hideNavTooltip, true);
    window.addEventListener('resize', hideNavTooltip);
  };

  const init = () => {
    const theme = resolveInitialTheme();
    applyTheme(theme, { save: false });
    updateToggleLabel(theme);
    initNav();
    bindNavTooltips();
    ensureVersionBadge();

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
