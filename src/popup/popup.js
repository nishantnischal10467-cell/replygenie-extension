const autoCopyEl    = document.getElementById("autoCopy");
const jumpToPostsEl = document.getElementById("jumpToPosts");
const toneEl        = document.getElementById("tone");
const lengthPills   = document.querySelectorAll(".length-pill");
const keyStatusEl   = document.getElementById("key-status");
const keyDetailEl   = document.getElementById("key-detail");

function setActivePill(value) {
  lengthPills.forEach((pill) => {
    pill.classList.toggle("active", pill.dataset.value === value);
  });
}

function load() {
  chrome.storage.sync.get({ profile: null }, (data) => {
    const profile = data.profile || {};
    autoCopyEl.checked    = profile.autoCopy !== false;
    jumpToPostsEl.checked = profile.jumpToPosts !== false;
    toneEl.value          = profile.tone || "Witty";
    setActivePill(profile.length || "Medium");

    const hasKey = !!(profile.apiKey);
    if (hasKey) {
      keyStatusEl.textContent = "OpenAI key connected \u2713";
      keyDetailEl.textContent = profile.handle ? profile.handle : "Ready to draft replies";
    } else {
      keyStatusEl.textContent = "No API key set";
      keyDetailEl.textContent = "Add one in options";
    }
  });
}

function save(partial) {
  chrome.storage.sync.get({ profile: {} }, (data) => {
    const merged = { ...data.profile, ...partial };
    chrome.storage.sync.set({ profile: merged });
  });
}

autoCopyEl.addEventListener("change",    () => save({ autoCopy:    autoCopyEl.checked }));
jumpToPostsEl.addEventListener("change", () => save({ jumpToPosts: jumpToPostsEl.checked }));
toneEl.addEventListener("change",        () => save({ tone:        toneEl.value }));

lengthPills.forEach((pill) => {
  pill.addEventListener("click", () => {
    setActivePill(pill.dataset.value);
    save({ length: pill.dataset.value });
  });
});

document.getElementById("open-options").addEventListener("click", () => chrome.runtime.openOptionsPage());
document.getElementById("edit-profile-btn").addEventListener("click", () => chrome.runtime.openOptionsPage());
document.getElementById("edit-profile-btn-2").addEventListener("click", () => chrome.runtime.openOptionsPage());

load();
