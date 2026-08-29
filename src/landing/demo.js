/**
 * ReplyGenie Landing Page Controller
 * Handles Theme Toggling, Scroll-Reveal Animations, Interactive Demo & FAQ Accordion
 */

// ---------- Theme Management (Light / Dark Mode) ----------
function initTheme() {
  const savedTheme = localStorage.getItem('replygenie_theme');
  const systemPrefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = savedTheme || (systemPrefersDark ? 'dark' : 'dark'); // Default dark
  setTheme(theme);
}

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('replygenie_theme', theme);
  updateThemeIcon(theme);
}

function toggleTheme() {
  const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
  setTheme(newTheme);
}

function updateThemeIcon(theme) {
  const iconContainer = document.getElementById('theme-toggle-icon');
  if (!iconContainer) return;
  
  if (theme === 'light') {
    // Moon Icon for Dark mode toggle
    iconContainer.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12.3 2a10 10 0 0 0 9.7 11.5 10 10 0 1 1-11.7-11.7z"/></svg>`;
    iconContainer.setAttribute('title', 'Switch to Dark Mode');
  } else {
    // Sun Icon for Light mode toggle
    iconContainer.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm0-5a1 1 0 0 1 1 1v2a1 1 0 1 1-2 0V3a1 1 0 0 1 1-1zm0 16a1 1 0 0 1 1 1v2a1 1 0 1 1-2 0v-2a1 1 0 0 1 1-1zM4.22 4.22a1 1 0 0 1 1.42 0l1.42 1.42a1 1 0 1 1-1.42 1.42L4.22 5.64a1 1 0 0 1 0-1.42zm12.72 12.72a1 1 0 0 1 1.42 0l1.42 1.42a1 1 0 0 1-1.42 1.42l-1.42-1.42a1 1 0 0 1 0-1.42zM2 12a1 1 0 0 1 1-1h2a1 1 0 1 1 0 2H3a1 1 0 0 1-1-1zm16 0a1 1 0 0 1 1-1h2a1 1 0 1 1 0 2h-2a1 1 0 0 1-1-1zM4.22 19.78a1 1 0 0 1 0-1.42l1.42-1.42a1 1 0 0 1 1.42 1.42l-1.42 1.42a1 1 0 0 1-1.42 0zm12.72-12.72a1 1 0 0 1 0-1.42l1.42-1.42a1 1 0 1 1 1.42 1.42l-1.42 1.42a1 1 0 0 1-1.42 0z"/></svg>`;
    iconContainer.setAttribute('title', 'Switch to Light Mode');
  }
}

// ---------- Live Interactive Demo Controller ----------
const demoReplies = {
  witty: [
    "Specific knowledge compounds even faster when media meets code — the real edge is shipping both in public.",
    "Code creates digital leverage, but writing creates human leverage. The real cheat code is combining both.",
    "Or build both. The modern builder writes code by day and context by night."
  ],
  insightful: [
    "Leverage without distribution is invisible. Output built in public serves as proof of work that compounds infinitely.",
    "The highest return on effort comes from assets that work for you while you sleep: code, media, and reputation.",
    "Media scales permissionlessly. Every piece of content is an employee working 24/7."
  ],
  concise: [
    "Code creates leverage. Media creates distribution. Do both.",
    "Output compounds faster than effort. Build in public.",
    "Leverage is earned, not given. Ship consistently."
  ]
};

let currentTone = 'witty';
let replyIdx = 0;
let isGenerating = false;

function setDemoTone(btn, tone) {
  if (isGenerating) return;
  document.querySelectorAll('.tone-pill').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  currentTone = tone;
  replyIdx = 0;
  triggerGenerationAnimation();
}

function updateDemoText() {
  const el = document.getElementById('demo-reply-text');
  if (el) {
    el.textContent = demoReplies[currentTone][replyIdx % demoReplies[currentTone].length];
  }
}

function triggerGenerationAnimation() {
  isGenerating = true;
  const statusEl = document.getElementById('demo-status');
  const textEl = document.getElementById('demo-reply-text');
  
  if (statusEl) {
    statusEl.textContent = '⚡ Generating...';
    statusEl.style.color = '#0070f3';
  }
  
  if (textEl) {
    textEl.classList.add('generating');
  }
  
  setTimeout(() => {
    updateDemoText();
    if (textEl) {
      textEl.classList.remove('generating');
    }
    if (statusEl) {
      statusEl.textContent = '● Ready';
      statusEl.style.color = 'var(--accent-cyan)';
    }
    isGenerating = false;
  }, 260);
}

function regenDemoReply() {
  if (isGenerating) return;
  replyIdx++;
  triggerGenerationAnimation();
}

function copyDemoReply() {
  const toast = document.getElementById('copy-toast');
  const textEl = document.getElementById('demo-reply-text');
  const copyBtn = document.getElementById('demo-copy-btn');
  
  if (textEl && navigator.clipboard) {
    navigator.clipboard.writeText(textEl.textContent.trim()).catch(() => {});
  }
  
  // Show toast notification
  if (toast) {
    toast.classList.add('show');
    setTimeout(() => {
      toast.classList.remove('show');
    }, 2000);
  }
  
  // Button micro-interaction feedback
  if (copyBtn) {
    const originalContent = copyBtn.innerHTML;
    copyBtn.classList.add('copied');
    copyBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="20 6 9 17 4 12"></polyline>
      </svg>
      Copied!
    `;
    setTimeout(() => {
      copyBtn.classList.remove('copied');
      copyBtn.innerHTML = originalContent;
    }, 1800);
  }
}

// ---------- Scroll-Reveal Intersection Observer ----------
function initScrollReveal() {
  const revealElements = document.querySelectorAll('.reveal');
  if (!revealElements.length) return;

  const observerOptions = {
    threshold: 0.12,
    rootMargin: '0px 0px -40px 0px'
  };

  const revealObserver = new IntersectionObserver((entries, observer) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('revealed');
        observer.unobserve(entry.target);
      }
    });
  }, observerOptions);

  revealElements.forEach(el => revealObserver.observe(el));
}

// ---------- Header Sticky Scroll Transition ----------
function initHeaderScroll() {
  const header = document.querySelector('header');
  if (!header) return;

  const handleScroll = () => {
    if (window.scrollY > 24) {
      header.classList.add('scrolled');
    } else {
      header.classList.remove('scrolled');
    }
  };

  window.addEventListener('scroll', handleScroll, { passive: true });
  handleScroll();
}

// ---------- FAQ Interactive Accordion ----------
function initFaqAccordion() {
  const faqItems = document.querySelectorAll('.faq-item');
  if (!faqItems.length) return;

  faqItems.forEach((item, index) => {
    const questionBtn = item.querySelector('.faq-question');
    if (!questionBtn) return;

    // Open first FAQ by default for discovery
    if (index === 0) {
      item.classList.add('active');
      questionBtn.setAttribute('aria-expanded', 'true');
    } else {
      questionBtn.setAttribute('aria-expanded', 'false');
    }

    questionBtn.addEventListener('click', () => {
      const isOpen = item.classList.contains('active');
      
      // Close other items
      faqItems.forEach(otherItem => {
        if (otherItem !== item) {
          otherItem.classList.remove('active');
          const btn = otherItem.querySelector('.faq-question');
          if (btn) btn.setAttribute('aria-expanded', 'false');
        }
      });

      // Toggle current item
      if (isOpen) {
        item.classList.remove('active');
        questionBtn.setAttribute('aria-expanded', 'false');
      } else {
        item.classList.add('active');
        questionBtn.setAttribute('aria-expanded', 'true');
      }
    });
  });
}

// ---------- DOM Content Loaded Initialization ----------
initTheme();

document.addEventListener('DOMContentLoaded', () => {
  initScrollReveal();
  initHeaderScroll();
  initFaqAccordion();

  const triggerBtn = document.getElementById('demo-trigger-btn');
  if (triggerBtn) {
    triggerBtn.addEventListener('click', regenDemoReply);
  }
  
  const themeBtn = document.getElementById('theme-toggle-btn');
  if (themeBtn) {
    themeBtn.addEventListener('click', toggleTheme);
  }
  
  updateThemeIcon(document.documentElement.getAttribute('data-theme') || 'dark');
});
