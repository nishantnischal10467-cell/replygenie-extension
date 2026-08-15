// storage.js — shared defaults & helpers, loaded by popup/options/background via importScripts or <script>
const DEFAULT_PROFILE = {
  apiKey: "",
  handle: "",
  aboutYou: "",
  intentions: "",
  interests: "",
  mentionWhenRelevant: "",
  neverMention: "",
  tone: "Witty",
  length: "Medium",
  autoCopy: true,
  jumpToPosts: true,
  voiceSamples: [] // learned from the user's own manual replies
};

function getProfile() {
  return new Promise((resolve) => {
    chrome.storage.sync.get({ profile: DEFAULT_PROFILE }, (data) => resolve(data.profile));
  });
}

function saveProfile(partial) {
  return getProfile().then((current) => {
    const merged = { ...current, ...partial };
    return new Promise((resolve) => {
      chrome.storage.sync.set({ profile: merged }, () => resolve(merged));
    });
  });
}
