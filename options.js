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

function setActiveChip(containerId, value) {
  document.querySelectorAll(`#${containerId} button`).forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.value === value);
  });
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
  });
}

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

document.getElementById("save").addEventListener("click", () => {
  chrome.storage.sync.get({ profile: {} }, (data) => {
    const updates = {};
    fields.forEach((f) => {
      const el = document.getElementById(f);
      if (el) updates[f] = el.value.trim();
    });
    updates.tone = selectedTone;
    updates.length = selectedLength;

    const merged = { ...data.profile, ...updates };
    chrome.storage.sync.set({ profile: merged }, () => {
      const msg = document.getElementById("saved-msg");
      msg.textContent = "Saved ✓";
      setTimeout(() => (msg.textContent = ""), 1500);
    });
  });
});

load();
