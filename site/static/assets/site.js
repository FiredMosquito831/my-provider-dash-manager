(() => {
  const toggle = document.querySelector('[data-nav-toggle]');
  const nav = document.getElementById('site-nav');

  if (toggle && nav) {
    const setOpen = (open) => {
      toggle.setAttribute('aria-expanded', String(open));
      nav.classList.toggle('is-open', open);
    };

    toggle.addEventListener('click', () => {
      setOpen(toggle.getAttribute('aria-expanded') !== 'true');
    });

    nav.addEventListener('click', (event) => {
      if (event.target.closest('a')) setOpen(false);
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') {
        setOpen(false);
        toggle.focus();
      }
    });

    document.addEventListener('click', (event) => {
      if (!nav.contains(event.target) && !toggle.contains(event.target)) setOpen(false);
    });
  }

  const copyText = async (text) => {
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch {
        // Headless browsers and restrictive permissions reject the async clipboard API;
        // fall through to the selection-based copy path.
      }
    }
    const input = document.createElement('textarea');
    input.value = text;
    input.setAttribute('readonly', '');
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.appendChild(input);
    input.select();
    const copied = document.execCommand('copy');
    input.remove();
    if (!copied) throw new Error('copy failed');
  };

  document.querySelectorAll('[data-copy]').forEach((button) => {
    button.addEventListener('click', async () => {
      const status = button.parentElement.querySelector('.copy-status');
      const original = button.textContent;
      try {
        await copyText(button.getAttribute('data-copy') || '');
        button.textContent = 'Copied';
        button.classList.add('is-copied');
        if (status) status.textContent = 'Copied to clipboard';
      } catch {
        button.textContent = 'Select';
        if (status) status.textContent = 'Select the command and copy it';
      }
      window.setTimeout(() => {
        button.textContent = original;
        button.classList.remove('is-copied');
        if (status) status.textContent = '';
      }, 2200);
    });
  });
})();
