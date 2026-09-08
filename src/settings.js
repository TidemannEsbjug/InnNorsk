const fs = require("fs");
const path = require("path");
const { app, safeStorage } = require("electron");

const FILE = () => path.join(app.getPath("userData"), "settings.json");

const DEFAULTS = {
  apiKeyEnc: null,
  apiKeyPlain: "",
  model: "grok-4.6",
  targetLanguage: "bokmal",
  inputFolder: "",
  outputFolder: "",
  skipExisting: true,
};

function readRaw() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE(), "utf8")) };
  } catch {
    return { ...DEFAULTS };
  }
}

function writeRaw(data) {
  fs.mkdirSync(path.dirname(FILE()), { recursive: true });
  fs.writeFileSync(FILE(), JSON.stringify(data, null, 2), "utf8");
}

function decryptKey(raw) {
  if (raw.apiKeyEnc && safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(raw.apiKeyEnc, "base64"));
    } catch {
      /* fall through */
    }
  }
  return raw.apiKeyPlain || "";
}

function getSettings() {
  const raw = readRaw();
  const apiKey = decryptKey(raw);
  const { apiKeyEnc, apiKeyPlain, ...rest } = raw;
  return {
    ...rest,
    apiKey,
    hasApiKey: Boolean(apiKey && apiKey.trim()),
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
  };
}

function saveSettings(patch) {
  const raw = readRaw();
  const next = { ...raw };

  if (typeof patch.model === "string") next.model = patch.model;
  if (typeof patch.targetLanguage === "string") next.targetLanguage = patch.targetLanguage;
  if (typeof patch.inputFolder === "string") next.inputFolder = patch.inputFolder;
  if (typeof patch.outputFolder === "string") next.outputFolder = patch.outputFolder;
  if (typeof patch.skipExisting === "boolean") next.skipExisting = patch.skipExisting;

  if (typeof patch.apiKey === "string") {
    const key = patch.apiKey.trim();
    if (!key) {
      next.apiKeyEnc = null;
      next.apiKeyPlain = "";
    } else if (safeStorage.isEncryptionAvailable()) {
      next.apiKeyEnc = safeStorage.encryptString(key).toString("base64");
      next.apiKeyPlain = "";
    } else {
      next.apiKeyEnc = null;
      next.apiKeyPlain = key;
    }
  }

  writeRaw(next);
  return getSettings();
}

function defaultOutputFolder(inputFolder) {
  if (!inputFolder) return "";
  return path.join(inputFolder, "oversatt");
}

module.exports = { getSettings, saveSettings, defaultOutputFolder };
