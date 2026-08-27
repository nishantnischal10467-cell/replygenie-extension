// src/tests/setup.js
// Jest global setup — stubs the Chrome extension APIs so modules that reference
// chrome.* can be require()'d without a browser environment.
// Only stubs are defined here. Tests needing specific return values should
// use jest.fn() to override them locally.

global.chrome = {
  storage: {
    sync: {
      get:  jest.fn((defaults, cb) => cb(defaults)),
      set:  jest.fn((data, cb)     => cb && cb()),
    },
    local: {
      get:  jest.fn((defaults, cb) => cb(defaults)),
      set:  jest.fn((data, cb)     => cb && cb()),
    },
  },
  runtime: {
    lastError: null,
  },
};
