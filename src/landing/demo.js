/**
 * ReplyGenie Landing Page Interactive Live Demo Controller
 */

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

function setDemoTone(btn, tone) {
  document.querySelectorAll('.tone-pill').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  currentTone = tone;
  replyIdx = 0;
  updateDemoText();
}

function updateDemoText() {
  const el = document.getElementById('demo-reply-text');
  if (el) {
    el.textContent = demoReplies[currentTone][replyIdx % demoReplies[currentTone].length];
  }
}

function regenDemoReply() {
  const statusEl = document.getElementById('demo-status');
  if (statusEl) {
    statusEl.textContent = '⚡ Generating...';
    statusEl.style.color = '#0070f3';
  }
  
  setTimeout(() => {
    replyIdx++;
    updateDemoText();
    if (statusEl) {
      statusEl.textContent = '● Ready';
      statusEl.style.color = '#50e3c2';
    }
  }, 300);
}

function copyDemoReply() {
  const toast = document.getElementById('copy-toast');
  const textEl = document.getElementById('demo-reply-text');
  if (textEl && navigator.clipboard) {
    navigator.clipboard.writeText(textEl.textContent).catch(() => {});
  }
  
  if (toast) {
    toast.classList.add('show');
    setTimeout(() => {
      toast.classList.remove('show');
    }, 2000);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const triggerBtn = document.getElementById('demo-trigger-btn');
  if (triggerBtn) {
    triggerBtn.addEventListener('click', regenDemoReply);
  }
});
