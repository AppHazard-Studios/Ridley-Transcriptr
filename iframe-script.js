// This script gets injected into Vimeo iframes to help access content
console.log("Ridley Transcriptor iframe helper loaded");

// Find and click the transcript button
function findAndClickTranscriptButton() {
  console.log("Looking for transcript button...");

  // Look for buttons with text or aria-label containing "transcript" or "cc"
  const buttons = Array.from(document.querySelectorAll('button'));

  // First, look for buttons with "transcript" in them
  let transcriptBtn = buttons.find(btn =>
      (btn.textContent && btn.textContent.toLowerCase().includes('transcript')) ||
      (btn.getAttribute('aria-label') && btn.getAttribute('aria-label').toLowerCase().includes('transcript'))
  );

  // If not found, try buttons with "cc" or "caption" or "subtitle"
  if (!transcriptBtn) {
    transcriptBtn = buttons.find(btn =>
        (btn.textContent && btn.textContent.toLowerCase().includes('cc')) ||
        (btn.getAttribute('aria-label') && btn.getAttribute('aria-label').toLowerCase().includes('caption')) ||
        (btn.getAttribute('aria-label') && btn.getAttribute('aria-label').toLowerCase().includes('subtitle'))
    );
  }

  if (transcriptBtn) {
    console.log("Found transcript button:", transcriptBtn);
    transcriptBtn.click();

    // Notify the parent window that the button was clicked
    window.parent.postMessage({
      action: 'transcriptButtonClicked',
      success: true
    }, '*');

    return true;
  }

  console.log("Transcript button not found");

  // Notify the parent window that the button was not found
  window.parent.postMessage({
    action: 'transcriptButtonClicked',
    success: false,
    error: 'Transcript button not found'
  }, '*');

  return false;
}

// Try immediately and then retry
setTimeout(findAndClickTranscriptButton, 500);