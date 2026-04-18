// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// ATLAS Browser Bridge — Popup UI
// Shows connection status, send buttons, and quick message input.
// Communicates with background.js via chrome.runtime.sendMessage.

const statusDot = document.getElementById("statusDot");
const statusLabel = document.getElementById("statusLabel");
const btnSendPage = document.getElementById("btnSendPage");
const btnSendSelection = document.getElementById("btnSendSelection");
const messageInput = document.getElementById("messageInput");
const btnSend = document.getElementById("btnSend");
const responseArea = document.getElementById("responseArea");
const responseText = document.getElementById("responseText");
const btnReconnect = document.getElementById("btnReconnect");

let isConnected = false;

// ── Status Refresh ───────────────────────────

function refreshStatus() {
  chrome.runtime.sendMessage({ type: "get_status" }, (response) => {
    if (chrome.runtime.lastError || !response) {
      setConnected(false, "Offline");
      return;
    }

    if (response.connected) {
      setConnected(true, "Connected");
    } else if (response.discoveryAttempts > 0) {
      setConnected(false, "Searching...");
      statusDot.classList.add("connecting");
    } else {
      setConnected(false, "Offline");
    }

    // Show last response if available
    if (response.lastResponse) {
      showResponse(response.lastResponse);
    }
  });
}

function setConnected(connected, label) {
  isConnected = connected;
  statusDot.classList.remove("connected", "connecting");

  if (connected) {
    statusDot.classList.add("connected");
  }

  statusLabel.textContent = label;

  // Enable/disable controls
  btnSendPage.disabled = !connected;
  btnSendSelection.disabled = !connected;
  messageInput.disabled = !connected;
  btnSend.disabled = !connected;

  if (connected) {
    messageInput.placeholder = "Quick message...";
  } else {
    messageInput.placeholder = "Not connected";
  }
}

// ── Show Response Snippet ────────────────────

function showResponse(text) {
  if (!text) return;
  // Truncate to ~150 chars for the small popup
  const truncated = text.length > 150 ? text.substring(0, 147) + "..." : text;
  responseText.textContent = truncated;
  responseArea.classList.add("visible");
}

// ── Send Page Context ────────────────────────

btnSendPage.addEventListener("click", () => {
  if (!isConnected) return;
  btnSendPage.textContent = "Sending...";
  btnSendPage.disabled = true;

  chrome.runtime.sendMessage({ type: "send_page" }, (resp) => {
    btnSendPage.innerHTML = '<span class="btn-icon">&#128196;</span> Send page to ATLAS';
    btnSendPage.disabled = false;

    if (resp && resp.ok) {
      btnSendPage.innerHTML = '<span class="btn-icon">&#10003;</span> Sent!';
      setTimeout(() => {
        btnSendPage.innerHTML = '<span class="btn-icon">&#128196;</span> Send page to ATLAS';
      }, 1500);
    }
  });
});

// ── Send Selection ───────────────────────────

btnSendSelection.addEventListener("click", () => {
  if (!isConnected) return;
  btnSendSelection.textContent = "Sending...";
  btnSendSelection.disabled = true;

  chrome.runtime.sendMessage({ type: "send_selection" }, (resp) => {
    btnSendSelection.innerHTML = '<span class="btn-icon">&#9997;</span> Send selection to ATLAS';
    btnSendSelection.disabled = false;

    if (resp && resp.ok) {
      btnSendSelection.innerHTML = '<span class="btn-icon">&#10003;</span> Sent!';
      setTimeout(() => {
        btnSendSelection.innerHTML = '<span class="btn-icon">&#9997;</span> Send selection to ATLAS';
      }, 1500);
    }
  });
});

// ── Send Quick Message ───────────────────────

function sendMessage() {
  const text = messageInput.value.trim();
  if (!text || !isConnected) return;

  btnSend.disabled = true;
  btnSend.textContent = "...";
  messageInput.value = "";

  chrome.runtime.sendMessage({ type: "send_message", text }, (resp) => {
    btnSend.disabled = false;
    btnSend.textContent = "Send";

    if (resp && resp.ok) {
      btnSend.textContent = "Sent";
      setTimeout(() => {
        btnSend.textContent = "Send";
      }, 1000);
    }
  });
}

btnSend.addEventListener("click", sendMessage);

messageInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    sendMessage();
  }
});

// ── Reconnect ────────────────────────────────

btnReconnect.addEventListener("click", () => {
  btnReconnect.textContent = "Reconnecting...";
  btnReconnect.disabled = true;

  chrome.runtime.sendMessage({ type: "reconnect" }, () => {
    setTimeout(() => {
      btnReconnect.textContent = "Reconnect";
      btnReconnect.disabled = false;
      refreshStatus();
    }, 2000);
  });
});

// ── Listen for Live Updates from Background ──

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "atlas_response") {
    showResponse(msg.text);
  }

  if (msg.type === "atlas_progress") {
    // Show progress in response area temporarily
    if (msg.text) {
      responseText.textContent = msg.text;
      responseArea.classList.add("visible");
    }
  }

  if (msg.type === "atlas_error") {
    responseText.textContent = msg.text || "Error";
    responseArea.classList.add("visible");
  }
});

// ── Auto-refresh ─────────────────────────────

refreshStatus();
setInterval(refreshStatus, 3000);
