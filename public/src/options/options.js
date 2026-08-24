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
  const container = document.getElementById(containerId);
  if (!container) return;
  container.querySelectorAll("button").forEach((btn) => {
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
  const selectEl = document.getElementById("tplCategorySelect") || document.getElementById("tpl-category");
  const listEl = document.getElementById("tplListContainer") || document.getElementById("tpl-list");
  if (!selectEl || !listEl) return;

  const categoryKey = selectEl.value;
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
  const selectEl = document.getElementById("tplCategorySelect") || document.getElementById("tpl-category");
  const inputEl = document.getElementById("newTplInput") || document.getElementById("new-tpl-input");
  if (!selectEl || !inputEl) return;

  const categoryKey = selectEl.value;
  const text = inputEl.value.trim();

  if (!text) return;

  const items = getActiveTemplatesForCategory(categoryKey);
  items.push(text);
  currentCustomTemplates[categoryKey] = items;

  inputEl.value = "";
  renderTemplates();
}

function resetCategoryTemplates() {
  const selectEl = document.getElementById("tplCategorySelect") || document.getElementById("tpl-category");
  if (!selectEl) return;
  const categoryKey = selectEl.value;
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

    const voiceSamples = profile.voiceSamples || [];
    const count = voiceSamples.length;
    const voiceCountEl = document.getElementById("voice-count");
    if (voiceCountEl) {
      voiceCountEl.textContent = `${count} repl${count === 1 ? "y" : "ies"} learned so far`;
    }
    const voiceSamplesTextEl = document.getElementById("voiceSamplesText");
    if (voiceSamplesTextEl) {
      voiceSamplesTextEl.value = voiceSamples.length > 0 
        ? voiceSamples.join("\n\n") 
        : "";
    }

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

const clearVoiceBtn = document.getElementById("clearVoice") || document.getElementById("clear-voice");
if (clearVoiceBtn) {
  clearVoiceBtn.addEventListener("click", () => {
    chrome.storage.sync.get({ profile: {} }, (data) => {
      const merged = { ...data.profile, voiceSamples: [] };
      chrome.storage.sync.set({ profile: merged }, load);
    });
  });
}

const categorySelect = document.getElementById("tplCategorySelect") || document.getElementById("tpl-category");
if (categorySelect) {
  categorySelect.addEventListener("change", renderTemplates);
}

const addBtn = document.getElementById("addTplBtn") || document.getElementById("add-tpl-btn");
if (addBtn) {
  addBtn.addEventListener("click", addTemplateItem);
}

const newTplInput = document.getElementById("newTplInput") || document.getElementById("new-tpl-input");
if (newTplInput) {
  newTplInput.addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addTemplateItem();
    }
  });
}

const resetBtn = document.getElementById("resetTplBtn") || document.getElementById("reset-category-btn");
if (resetBtn) {
  resetBtn.addEventListener("click", resetCategoryTemplates);
}

const saveBtn = document.getElementById("save");
if (saveBtn) {
  saveBtn.addEventListener("click", () => {
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
        const msg = document.getElementById("savedMsg") || document.getElementById("saved-msg");
        if (msg) {
          msg.textContent = "Saved profile & settings ✓";
          setTimeout(() => (msg.textContent = ""), 1800);
        }
      });
    });
  });
}

load();
