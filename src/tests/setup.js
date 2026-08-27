// src/tests/setup.js
// Jest global setup — stubs Chrome extension APIs and IndexedDB for testing.

require("fake-indexeddb/auto");

global.chrome = {
  storage: {
    sync: {
      get:  jest.fn((defaults, cb) => cb(defaults)),
      set:  jest.fn((data, cb)     => cb && cb()),
    },
    local: {
      get:  jest.fn((defaults, cb) => cb(defaults)),
      set:  jest.fn((data, cb)     => cb && cb()),
      clear: jest.fn((cb)          => cb && cb()),
    },
  },
  alarms: {
    get: jest.fn((name, cb) => cb && cb(null)),
    create: jest.fn(),
    onAlarm: {
      addListener: jest.fn(),
    },
  },
  runtime: {
    lastError: null,
  },
};

