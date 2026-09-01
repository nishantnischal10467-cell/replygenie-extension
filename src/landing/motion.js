/**
 * ReplyGenie — Advanced Motion & Dynamic Effects
 * Pure vanilla JS + Canvas API. Zero external dependencies.
 * Full prefers-reduced-motion support throughout.
 */

const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* =========================================================================
   1. HERO CANVAS PARTICLE NETWORK
   Floating nodes connected by accent-coloured lines — gives the hero
   a live "AI graph / neural-net" feel.
   ========================================================================= */
function initParticleCanvas() {
  if (REDUCED_MOTION) return;
  const canvas = document.getElementById('hero-canvas');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  const N   = 48;
  const MAX = 140;
  const BLUE = { r: 59,  g: 130, b: 246 };
  const CYAN = { r: 0,   g: 223, b: 143 };

  let W = 0, H = 0, pts = [];

  function resize() {
    W = canvas.offsetWidth;
    H = canvas.offsetHeight;
    canvas.width  = W * devicePixelRatio;
    canvas.height = H * devicePixelRatio;
    ctx.scale(devicePixelRatio, devicePixelRatio);
  }

  function mk() {
    return {
      x: Math.random() * W, y: Math.random() * H,
      vx: (Math.random() - .5) * .45, vy: (Math.random() - .5) * .45,
      r: Math.random() * 1.8 + .8, c: Math.random() < .3 ? CYAN : BLUE
    };
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);

    for (const p of pts) {
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0 || p.x > W) p.vx *= -1;
      if (p.y < 0 || p.y > H) p.vy *= -1;
    }

    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const dx = pts[i].x - pts[j].x, dy = pts[i].y - pts[j].y;
        const d = Math.hypot(dx, dy);
        if (d < MAX) {
          const alpha = (1 - d / MAX) * .18;
          const { r, g, b } = pts[i].c;
          ctx.beginPath();
          ctx.moveTo(pts[i].x, pts[i].y);
          ctx.lineTo(pts[j].x, pts[j].y);
          ctx.strokeStyle = `rgba(${r},${g},${b},${alpha})`;
          ctx.lineWidth = .8;
          ctx.stroke();
        }
      }
    }

    for (const p of pts) {
      const { r, g, b } = p.c;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${r},${g},${b},.55)`;
      ctx.fill();
    }

    requestAnimationFrame(draw);
  }

  new ResizeObserver(resize).observe(canvas);
  resize();
  pts = Array.from({ length: N }, mk);
  draw();
}

/* =========================================================================
   2. TYPING CURSOR on hero h1
   ========================================================================= */
function initTypingCursor() {
  if (REDUCED_MOTION) return;
  const h1 = document.querySelector('.hero-text h1');
  if (!h1) return;

  const cur = document.createElement('span');
  cur.className = 'typing-cursor';
  cur.setAttribute('aria-hidden', 'true');
  cur.textContent = '|';
  h1.appendChild(cur);

  // Stop blinking after 6s so it is not permanently distracting
  setTimeout(() => {
    cur.style.transition = 'opacity .5s ease';
    cur.style.opacity = '0';
  }, 6000);
}

/* =========================================================================
   3. MOUSE-PARALLAX TILT on the App Frame
   ========================================================================= */
function initAppFrameTilt() {
  if (REDUCED_MOTION) return;
  const frame  = document.querySelector('.app-frame');
  const visual = document.querySelector('.hero-visual');
  if (!frame || !visual) return;

  visual.style.perspective = '900px';
  let cx = 0, cy = 0, tx = 0, ty = 0;

  visual.addEventListener('mousemove', e => {
    const r = visual.getBoundingClientRect();
    tx = -(e.clientY - r.top  - r.height / 2) / (r.height / 2) * 6;
    ty =  (e.clientX - r.left - r.width  / 2) / (r.width  / 2) * 6;
  }, { passive: true });

  visual.addEventListener('mouseleave', () => { tx = 0; ty = 0; }, { passive: true });

  (function tick() {
    cx += (tx - cx) * .08;
    cy += (ty - cy) * .08;
    frame.style.transform = `rotateX(${cx}deg) rotateY(${cy}deg)`;
    requestAnimationFrame(tick);
  })();
}

/* =========================================================================
   4. CARD SPOTLIGHT — radial glow follows cursor inside each workflow card
   ========================================================================= */
function initCardSpotlight() {
  if (REDUCED_MOTION) return;

  document.querySelectorAll('.workflow-step').forEach(card => {
    card.addEventListener('mousemove', e => {
      const r = card.getBoundingClientRect();
      card.style.setProperty('--sx', `${((e.clientX - r.left) / r.width  * 100).toFixed(1)}%`);
      card.style.setProperty('--sy', `${((e.clientY - r.top)  / r.height * 100).toFixed(1)}%`);
      card.classList.add('spotlight-active');
    }, { passive: true });

    card.addEventListener('mouseleave', () => {
      card.classList.remove('spotlight-active');
    }, { passive: true });
  });
}

/* =========================================================================
   5. COUNT-UP ANIMATION  (targets [data-count] elements)
   ========================================================================= */
function initCounters() {
  const els = document.querySelectorAll('[data-count]');
  if (!els.length) return;

  const easeOut = t => 1 - Math.pow(1 - t, 3);
  const DUR = REDUCED_MOTION ? 0 : 1400;

  const io = new IntersectionObserver((entries, obs) => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      obs.unobserve(entry.target);

      const el     = entry.target;
      const target = parseFloat(el.dataset.count);
      const suffix = el.dataset.suffix || '';
      const prefix = el.dataset.prefix || '';

      if (!DUR) { el.textContent = `${prefix}${target}${suffix}`; return; }

      const t0 = performance.now();
      (function step(t) {
        const p   = Math.min((t - t0) / DUR, 1);
        const val = target * easeOut(p);
        el.textContent = `${prefix}${Number.isInteger(target) ? Math.round(val).toLocaleString() : val.toFixed(1)}${suffix}`;
        if (p < 1) requestAnimationFrame(step);
      })(performance.now());
    });
  }, { threshold: .5 });

  els.forEach(el => io.observe(el));
}

/* =========================================================================
   6. MAGNETIC BUTTONS
   ========================================================================= */
function initMagneticButtons() {
  if (REDUCED_MOTION) return;

  document.querySelectorAll('.btn-hero-primary, .btn-primary').forEach(btn => {
    btn.addEventListener('mousemove', e => {
      const r  = btn.getBoundingClientRect();
      const dx = (e.clientX - r.left - r.width  / 2) * .28;
      const dy = (e.clientY - r.top  - r.height / 2) * .28;
      btn.style.transform = `translate(${dx}px,${dy}px) scale(1.03)`;
    }, { passive: true });

    btn.addEventListener('mouseleave', () => {
      btn.style.transform = '';
    }, { passive: true });
  });
}

/* =========================================================================
   7. SCROLL PROGRESS BAR — 2px accent line fills as user scrolls
   ========================================================================= */
function initScrollProgress() {
  if (REDUCED_MOTION) return;

  const bar = document.createElement('div');
  bar.id = 'scroll-progress-bar';
  bar.setAttribute('aria-hidden', 'true');
  document.body.prepend(bar);

  const update = () => {
    const h = document.documentElement.scrollHeight - window.innerHeight;
    bar.style.width = h > 0 ? `${(window.scrollY / h) * 100}%` : '0%';
  };

  window.addEventListener('scroll', update, { passive: true });
  update();
}

/* =========================================================================
   8. WORD-BY-WORD REVEAL on section headings
   ========================================================================= */
function initHeadingReveal() {
  if (REDUCED_MOTION) return;

  document.querySelectorAll('.section-title').forEach(h => {
    const words = h.textContent.trim().split(' ');
    h.innerHTML = words
      .map((w, i) => `<span class="word-reveal" style="transition-delay:${i * 65}ms">${w}\u00a0</span>`)
      .join('');

    const io = new IntersectionObserver((entries, obs) => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        obs.unobserve(entry.target);
        entry.target.querySelectorAll('.word-reveal').forEach(w => w.classList.add('word-visible'));
      });
    }, { threshold: .25 });

    io.observe(h);
  });
}

/* =========================================================================
   BOOT
   ========================================================================= */
document.addEventListener('DOMContentLoaded', () => {
  initParticleCanvas();
  initTypingCursor();
  initAppFrameTilt();
  initCardSpotlight();
  initCounters();
  initMagneticButtons();
  initScrollProgress();
  initHeadingReveal();
});
