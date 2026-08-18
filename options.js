const fields = [
  "apiKey",
  "handle",
  "aboutYou",
  "intentions",
  "interests",
  "mentionWhenRelevant",
  "neverMention",
];

let selectedTone = "Witty";
let selectedLength = "Medium";
let currentCustomTemplates = {};

function setActiveChip(containerId, value) {
  document.querySelectorAll(`#${containerId} button`).forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.value === value);
  });
}

function getActiveTemplatesForCategory(categoryKey) {
  if (currentCustomTemplates[categoryKey] && Array.isArray(currentCustomTemplates[categoryKey])) {
    return currentCustomTemplates[categoryKey];
  }
  if (typeof TEMPLATES !== "undefined" && TEMPLATES[categoryKey]) {
    return [...TEMPLATES[categoryKey]];
  }
  return [];
}

function renderTemplates() {
  const categoryKey = document.getElementById("tpl-category").value;
  const listEl = document.getElementById("tpl-list");
  const items = getActiveTemplatesForCategory(categoryKey);

  listEl.innerHTML = "";

  if (items.length === 0) {
    listEl.innerHTML = `<div class="empty-tpl">No generic templates for this category yet. Add one below!</div>`;
    return;
  }

  items.forEach((itemText, idx) => {
    const itemRow = document.createElement("div");
    itemRow.className = "tpl-item-row";

    const textSpan = document.createElement("span");
    textSpan.className = "tpl-text";
    textSpan.textContent = itemText;

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "tpl-del-btn";
    delBtn.title = "Delete template";
    delBtn.innerHTML = "&times;";
    delBtn.addEventListener("click", () => {
      deleteTemplateItem(categoryKey, idx);
    });

    itemRow.appendChild(textSpan);
    itemRow.appendChild(delBtn);
    listEl.appendChild(itemRow);
  });
}

function deleteTemplateItem(categoryKey, index) {
  const items = getActiveTemplatesForCategory(categoryKey);
  items.splice(index, 1);
  currentCustomTemplates[categoryKey] = items;
  renderTemplates();
}

function addTemplateItem() {
  const categoryKey = document.getElementById("tpl-category").value;
  const inputEl = document.getElementById("new-tpl-input");
  const text = inputEl.value.trim();

  if (!text) return;

  const items = getActiveTemplatesForCategory(categoryKey);
  items.push(text);
  currentCustomTemplates[categoryKey] = items;

  inputEl.value = "";
  renderTemplates();
}

function resetCategoryTemplates() {
  const categoryKey = document.getElementById("tpl-category").value;
  delete currentCustomTemplates[categoryKey];
  renderTemplates();
}

function load() {
  chrome.storage.sync.get({ profile: null }, (data) => {
    const profile = data.profile || {};
    fields.forEach((f) => {
      const el = document.getElementById(f);
      if (el) el.value = profile[f] || "";
    });
    selectedTone = profile.tone || "Witty";
    selectedLength = profile.length || "Medium";
    setActiveChip("tone-chips", selectedTone);
    setActiveChip("length-chips", selectedLength);

    const count = (profile.voiceSamples || []).length;
    document.getElementById("voice-count").textContent = `${count} repl${count === 1 ? "y" : "ies"} learned so far`;

    currentCustomTemplates = profile.customTemplates || {};
    renderTemplates();
  });
}

// Event Listeners

document.querySelectorAll("#tone-chips button").forEach((btn) => {
  btn.addEventListener("click", () => {
    selectedTone = btn.dataset.value;
    setActiveChip("tone-chips", selectedTone);
  });
});

document.querySelectorAll("#length-chips button").forEach((btn) => {
  btn.addEventListener("click", () => {
    selectedLength = btn.dataset.value;
    setActiveChip("length-chips", selectedLength);
  });
});

document.getElementById("clear-voice").addEventListener("click", () => {
  chrome.storage.sync.get({ profile: {} }, (data) => {
    const merged = { ...data.profile, voiceSamples: [] };
    chrome.storage.sync.set({ profile: merged }, load);
  });
});

document.getElementById("tpl-category").addEventListener("change", renderTemplates);

document.getElementById("add-tpl-btn").addEventListener("click", addTemplateItem);

document.getElementById("new-tpl-input").addEventListener("keypress", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    addTemplateItem();
  }
});

document.getElementById("reset-category-btn").addEventListener("click", resetCategoryTemplates);

document.getElementById("save").addEventListener("click", () => {
  chrome.storage.sync.get({ profile: {} }, (data) => {
    const updates = {};
    fields.forEach((f) => {
      const el = document.getElementById(f);
      if (el) updates[f] = el.value.trim();
    });
    updates.tone = selectedTone;
    updates.length = selectedLength;
    updates.customTemplates = currentCustomTemplates;

    const merged = { ...data.profile, ...updates };
    chrome.storage.sync.set({ profile: merged }, () => {
      const msg = document.getElementById("saved-msg");
      msg.textContent = "Saved profile & templates ✓";
      setTimeout(() => (msg.textContent = ""), 1800);
    });
  });
});

load();
