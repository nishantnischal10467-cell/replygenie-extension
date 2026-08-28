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
        <button class="rg-close" title="Close">×</button>
      </div>
      <div class="rg-error">${escapeHtml(state.message)}</div>
    `;
  } else if (state.status === "done") {
    const meta = state.meta || {};
    const strategyName = meta.strategy ? meta.strategy.replace(/_/g, " ") : null;
    const scoreVal = meta.compositeScore != null ? Number(meta.compositeScore).toFixed(1) : null;

    card.innerHTML = `
      <div class="rg-card-header">
        <span>${state.copied ? "Copied to clipboard ✓" : "Review Checkpoint"}</span>
        <button class="rg-close" title="Close">×</button>
      </div>
      ${strategyName || scoreVal ? `
        <div class="rg-meta-bar">
          ${strategyName ? `<span class="rg-badge rg-badge-strategy" title="Reply Strategy">${escapeHtml(strategyName)}</span>` : ""}
          ${scoreVal ? `<span class="rg-badge rg-badge-score" title="Quality Score">${scoreVal}/10</span>` : ""}
        </div>
      ` : ""}
      <textarea class="rg-textarea" placeholder="Edit reply before approving...">${escapeHtml(state.reply)}</textarea>
      <div class="rg-card-footer">
        <button class="rg-reject" title="Reject with feedback">Reject</button>
        <button class="rg-regen" title="Generate another reply">Regen</button>
        <button class="rg-approve rg-copy" title="Approve and copy reply">${state.copied ? "Approved ✓" : "Approve"}</button>
      </div>
      <div class="rg-reject-panel" style="display: none;">
        <div class="rg-reject-title">Reason for rejection:</div>
        <div class="rg-reject-tags">
          <button class="rg-tag-btn" data-tag="GENERIC">Generic</button>
          <button class="rg-tag-btn" data-tag="UNSUPPORTED_CLAIM">Unsupported Claim</button>
          <button class="rg-tag-btn" data-tag="FORCED_QUESTION">Forced Question</button>
          <button class="rg-tag-btn" data-tag="REPETITIVE">Repetitive</button>
          <button class="rg-tag-btn" data-tag="TOO_AGREEABLE">Too Agreeable</button>
          <button class="rg-tag-btn" data-tag="OFF_TOPIC">Off Topic</button>
          <button class="rg-tag-btn" data-tag="LOW_RELEVANCE">Low Relevance</button>
          <button class="rg-tag-btn" data-tag="OBVIOUS_AI">Obvious AI</button>
        </div>
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
      const textToApprove = ta ? ta.value : state.reply;
      copyToClipboard(textToApprove);
      copyBtn.textContent = "Approved ✓";
      copyBtn.classList.add("rg-approved");
      setTimeout(() => {
        removeCard();
      }, 700);
    });
  }

  const regenBtn = card.querySelector(".rg-regen");
  if (regenBtn) {
    regenBtn.addEventListener("click", () => {
      handleSuggestClick(state.article, anchorBtn, true);
    });
  }

  const rejectBtn = card.querySelector(".rg-reject");
  const rejectPanel = card.querySelector(".rg-reject-panel");
  if (rejectBtn && rejectPanel) {
    rejectBtn.addEventListener("click", () => {
      const isVisible = rejectPanel.style.display !== "none";
      rejectPanel.style.display = isVisible ? "none" : "block";
      rejectBtn.classList.toggle("rg-reject-active", !isVisible);
    });

    const tagBtns = rejectPanel.querySelectorAll(".rg-tag-btn");
    tagBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        const tag = btn.getAttribute("data-tag") || "GENERIC";
        const ta = card.querySelector(".rg-textarea");
        const replyText = ta ? ta.value : state.reply;
        const meta = state.meta || {};

        sendExtensionMessage({
          type: "RECORD_MANUAL_REJECTION",
          rejection: {
            source_post_id: meta.sourcePostId || (state.context ? state.context.text.slice(0, 80) : "unknown"),
            reply_text: replyText,
            failure_tag: tag,
            strategy: meta.strategy || null,
            scores: meta.scores || null,
          },
        }).catch(() => {});

        rejectPanel.innerHTML = `<div class="rg-feedback-saved">Feedback recorded (${tag}) ✓</div>`;
        setTimeout(() => {
          removeCard();
        }, 800);
      });
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

// ---------- Extension messaging helpers ----------

async function sendExtensionMessage(msg) {
  return new Promise((resolve, reject) => {
    try {
      if (!chrome.runtime || !chrome.runtime.id) {
        return reject(new Error("Extension reloaded or updated. Please refresh this page."));
      }
      chrome.runtime.sendMessage(msg, (response) => {
        const err = chrome.runtime.lastError;
        if (err) {
          const msgText = err.message || String(err);
          if (msgText.includes("invalidated") || msgText.includes("Extension context")) {
            return reject(new Error("Extension reloaded or updated. Please refresh this page."));
          }
          // Fallback to Port if sendMessage fails
          sendViaPort(msg).then(resolve).catch(reject);
          return;
        }
        if (!response) {
          return reject(new Error("No response from extension background script."));
        }
        if (response.error) {
          return reject(new Error(response.error));
        }
        resolve(response);
      });
    } catch (e) {
      if (e.message && (e.message.includes("invalidated") || e.message.includes("Extension context"))) {
        reject(new Error("Extension reloaded or updated. Please refresh this page."));
      } else {
        sendViaPort(msg).then(resolve).catch(reject);
      }
    }
  });
}

function sendViaPort(msg) {
  return new Promise((resolve, reject) => {
    let port;
    try {
      port = chrome.runtime.connect({ name: "reply-genie" });
    } catch (e) {
      const errText = e.message || String(e);
      if (errText.includes("invalidated")) {
        return reject(new Error("Extension reloaded or updated. Please refresh this page."));
      }
      return reject(new Error("Could not connect to extension. Try reloading the page."));
    }

    let handled = false;
    port.onMessage.addListener((response) => {
      handled = true;
      port.disconnect();
      if (response.error) {
        reject(new Error(response.error));
      } else {
        resolve(response);
      }
    });

    port.onDisconnect.addListener(() => {
      if (handled) return;
      const lastErr = chrome.runtime.lastError;
      if (lastErr && lastErr.message && (lastErr.message.includes("invalidated") || lastErr.message.includes("Extension context"))) {
        reject(new Error("Extension reloaded or updated. Please refresh this page."));
      } else {
        reject(new Error("Extension disconnected — retrying in a moment."));
      }
    });

    port.postMessage(msg);
  });
}

// ---------- Main flow ----------

async function handleSuggestClick(article, btn) {
  // Block if a cooldown is active or this tweet is already being processed
  if (inCooldown(btn) || _inFlight.has(article)) return;

  _inFlight.add(article);
  const ctx = extractTweetContext(article);
  showCard(btn, { status: "loading" });

  try {
    const res = await sendExtensionMessage({ type: "GENERATE_REPLY", context: ctx });
    _inFlight.delete(article);
    const replyText = (typeof res === "object" && res !== null && res.reply) ? res.reply : res;
    const meta = (typeof res === "object" && res !== null && res.meta) ? res.meta : null;

    chrome.storage.sync.get({ profile: { autoCopy: true } }, (data) => {
      const autoCopy = data.profile ? data.profile.autoCopy !== false : true;
      const requiresApproval = meta ? meta.requireHumanApproval !== false : false;
      if (autoCopy && !requiresApproval) {
        copyToClipboard(replyText);
      }
      showCard(btn, {
        status: "done",
        reply: replyText,
        meta: meta,
        copied: autoCopy && !requiresApproval,
        article,
        context: ctx,
      });
    });
  } catch (err) {
    _inFlight.delete(article);
    showCard(btn, { status: "error", message: err.message || String(err), article, context: ctx });
    startCooldown(btn);
  }
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
        sendExtensionMessage({ type: "LEARN_FROM_REPLY", replyText: text }).catch(() => {});
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
