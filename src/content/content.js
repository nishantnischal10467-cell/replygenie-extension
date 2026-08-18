// content.js — runs on x.com / twitter.com

const BTN_CLASS = "rg-suggest-btn";
const CARD_ID   = "rg-suggestion-card";

// ---------- Cooldown + in-flight state ----------

const COOLDOWN_SECS = 10; // seconds to wait after a failed request
const _inFlight  = new Set(); // articles currently being processed
const _cooldowns = new WeakMap(); // btn -> cooldown interval id

/** Locks the button with a live countdown, then re-enables it. */
function startCooldown(btn, seconds = COOLDOWN_SECS) {
  // Clear any existing cooldown on this button
  if (_cooldowns.has(btn)) clearInterval(_cooldowns.get(btn));

  const span = btn.querySelector("span");
  btn.classList.add("rg-cooldown");
  btn.setAttribute("aria-disabled", "true");
  let remaining = seconds;

  const tick = () => {
    if (span) span.textContent = `Retry in ${remaining}s`;
    remaining--;
    if (remaining < 0) {
      clearInterval(intervalId);
      _cooldowns.delete(btn);
      btn.classList.remove("rg-cooldown");
      btn.removeAttribute("aria-disabled");
      if (span) span.textContent = "Reply";
    }
  };

  tick(); // run immediately so the label changes at once
  const intervalId = setInterval(tick, 1000);
  _cooldowns.set(btn, intervalId);
}

/** Returns true if btn is in cooldown (should not fire). */
function inCooldown(btn) {
  return _cooldowns.has(btn);
}

// ---------- DOM extraction ----------

function upgradeImageUrl(src) {
  try {
    const u = new URL(src);
    if (u.hostname.includes("pbs.twimg.com")) {
      u.searchParams.set("name", "large");
      return u.toString();
    }
    return src;
  } catch {
    return src;
  }
}

function extractTweetContext(article) {
  const textEl = article.querySelector('[data-testid="tweetText"]');
  const text = textEl ? textEl.innerText.trim() : "";

  const authorEl = article.querySelector('[data-testid="User-Name"] a[href^="/"]');
  const handle = authorEl ? authorEl.getAttribute("href").replace("/", "@") : "";

  // Display name (e.g. "John Doe") — used for {name} template substitution
  const nameEl = article.querySelector('[data-testid="User-Name"] span');
  const displayName = nameEl ? nameEl.innerText.trim() : "";

  const imgEls = Array.from(article.querySelectorAll('[data-testid="tweetPhoto"] img'));
  const images = imgEls.map((img) => upgradeImageUrl(img.src)).slice(0, 4);

  const videoEl = article.querySelector('[data-testid="videoPlayer"] video, video');
  const hasVideo = !!videoEl;
  const videoPoster = videoEl && videoEl.poster ? videoEl.poster : null;

  return { text, handle, displayName, images, hasVideo, videoPoster };
}

// ---------- UI injection ----------

function makeButton() {
  const btn = document.createElement("div");
  btn.className = BTN_CLASS;
  btn.setAttribute("role", "button");
  btn.title = "Draft a reply";
  btn.innerHTML = `
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 2l1.8 5.6L19 9l-5.2 1.4L12 16l-1.8-5.6L5 9l5.2-1.4L12 2z" fill="currentColor"/>
      <path d="M19 14l.9 2.6L22 17l-2.1.8L19 20l-.9-2.2L16 17l2.1-.4L19 14z" fill="currentColor"/>
    </svg>
    <span>Reply</span>
  `;
  return btn;
}

function injectButtons(root = document) {
  const articles = root.querySelectorAll('article[data-testid="tweet"]');
  articles.forEach((article) => {
    const actionBar = article.querySelector('[role="group"]');
    if (!actionBar || actionBar.querySelector(`.${BTN_CLASS}`)) return;

    const wrapper = document.createElement("div");
    wrapper.style.display = "flex";
    wrapper.style.alignItems = "center";
    const btn = makeButton();
    wrapper.appendChild(btn);
    actionBar.appendChild(wrapper);

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleSuggestClick(article, btn);
    });
  });
}

// ---------- Suggestion card ----------

function removeCard() {
  const existing = document.getElementById(CARD_ID);
  if (existing) existing.remove();
}

function showCard(anchorBtn, state) {
  removeCard();
  const card = document.createElement("div");
  card.id = CARD_ID;

  if (state.status === "loading") {
    card.innerHTML = `
      <div class="rg-card-header">
        <span>Reading the post…</span>
      </div>
      <div class="rg-spinner"></div>
    `;
  } else if (state.status === "error") {
    card.innerHTML = `
      <div class="rg-card-header">
        <span>Couldn't generate a reply</span>
        <button class="rg-close">×</button>
      </div>
      <div class="rg-error">${escapeHtml(state.message)}</div>
    `;
  } else if (state.status === "done") {
    card.innerHTML = `
      <div class="rg-card-header">
        <span>${state.copied ? "Copied to clipboard ✓" : "Suggested reply"}</span>
        <button class="rg-close">×</button>
      </div>
      <textarea class="rg-textarea">${escapeHtml(state.reply)}</textarea>
      <div class="rg-card-footer">
        <button class="rg-regen">Regenerate</button>
        <button class="rg-copy">Copy</button>
      </div>
    `;
  }

  document.body.appendChild(card);
  positionCard(card, anchorBtn);

  const closeBtn = card.querySelector(".rg-close");
  if (closeBtn) closeBtn.addEventListener("click", removeCard);

  const copyBtn = card.querySelector(".rg-copy");
  if (copyBtn) {
    copyBtn.addEventListener("click", () => {
      const ta = card.querySelector(".rg-textarea");
      copyToClipboard(ta.value);
      copyBtn.textContent = "Copied!";
      setTimeout(() => (copyBtn.textContent = "Copy"), 1200);
    });
  }

  const regenBtn = card.querySelector(".rg-regen");
  if (regenBtn) {
    regenBtn.addEventListener("click", () => {
      handleSuggestClick(state.article, anchorBtn, true);
    });
  }

  return card;
}

function positionCard(card, anchorBtn) {
  const rect = anchorBtn.getBoundingClientRect();
  card.style.position = "fixed";
  card.style.top = `${Math.min(rect.bottom + 8, window.innerHeight - 220)}px`;
  card.style.left = `${Math.max(rect.left - 160, 12)}px`;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).catch(() => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  });
}

// ---------- Main flow ----------

async function handleSuggestClick(article, btn) {
  // Block if a cooldown is active or this tweet is already being processed
  if (inCooldown(btn) || _inFlight.has(article)) return;

  _inFlight.add(article);
  const ctx = extractTweetContext(article);
  showCard(btn, { status: "loading" });

  // Use a long-lived port so the MV3 service worker isn't killed mid-fetch
  let port;
  try {
    port = chrome.runtime.connect({ name: "reply-genie" });
  } catch (e) {
    _inFlight.delete(article);
    showCard(btn, { status: "error", message: "Could not connect to extension. Try reloading the page.", article });
    startCooldown(btn);
    return;
  }

  port.onMessage.addListener((response) => {
    port.disconnect();
    _inFlight.delete(article);
    if (response.error) {
      showCard(btn, { status: "error", message: response.error, article });
      startCooldown(btn);
      return;
    }
    chrome.storage.sync.get({ profile: { autoCopy: true } }, (data) => {
      const autoCopy = data.profile ? data.profile.autoCopy !== false : true;
      if (autoCopy) copyToClipboard(response.reply);
      showCard(btn, { status: "done", reply: response.reply, copied: autoCopy, article });
    });
  });

  port.onDisconnect.addListener(() => {
    _inFlight.delete(article);
    // Only show error if the card is still in loading state
    const card = document.getElementById(CARD_ID);
    if (card && card.querySelector(".rg-spinner")) {
      showCard(btn, { status: "error", message: "Extension disconnected — retrying in a moment.", article });
      startCooldown(btn);
    }
  });

  port.postMessage({ type: "GENERATE_REPLY", context: ctx });
}

// ---------- Learn voice from the user's own manually-sent replies ----------
// When the user posts a reply themselves (not via our button), capture the
// text right before it's sent so future suggestions match their real voice.

function watchForManualReplies() {
  document.addEventListener(
    "click",
    (e) => {
      const sendBtn = e.target.closest(
        '[data-testid="tweetButton"], [data-testid="tweetButtonInline"]'
      );
      if (!sendBtn) return;

      const editor = document.querySelector('[data-testid="tweetTextarea_0"]');
      const text = editor ? editor.innerText.trim() : "";
      if (text && text.length > 0) {
        try {
          const port = chrome.runtime.connect({ name: "reply-genie" });
          port.postMessage({ type: "LEARN_FROM_REPLY", replyText: text });
          port.onMessage.addListener(() => port.disconnect());
        } catch (e) {
          // Non-critical — silently ignore if extension isn't ready
        }
      }
    },
    true
  );
}
watchForManualReplies();

// ---------- Observe feed for dynamically loaded tweets ----------

const observer = new MutationObserver(() => injectButtons());
observer.observe(document.body, { childList: true, subtree: true });
injectButtons();

document.addEventListener("click", (e) => {
  const card = document.getElementById(CARD_ID);
  if (card && !card.contains(e.target) && !e.target.closest(`.${BTN_CLASS}`)) {
    removeCard();
  }
});
