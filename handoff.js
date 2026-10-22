"use strict";
document.getElementById("remove").addEventListener("click", () => {
  chrome.management.uninstallSelf({ showConfirmDialog: true }, () => void chrome.runtime.lastError);
});
document.getElementById("later").addEventListener("click", () => window.close());
