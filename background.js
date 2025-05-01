// Background Service Worker

// Store tab IDs for later use
let activeTabId = null;

// Listen for messages from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('Background script received message:', message);

    // Store the tab ID when we get messages from content scripts
    if (sender && sender.tab && sender.tab.id) {
        activeTabId = sender.tab.id;
    }

    if (message.action === 'getTabId') {
        // Return the active tab ID
        sendResponse({tabId: activeTabId || (sender && sender.tab && sender.tab.id)});
        return true;
    } else if (message.action === 'updateBadge') {
        // Update the badge with the number of videos
        if (message.count > 0) {
            chrome.action.setBadgeText({text: message.count.toString()});
            chrome.action.setBadgeBackgroundColor({color: '#BB86FC'});
            // Improve badge positioning - only use compatible API functions
            chrome.action.setBadgeTextColor({color: '#FFFFFF'});
            // Remove the setBadgePositionAdjust call that's causing the error
        } else {
            chrome.action.setBadgeText({text: ''});
        }
        sendResponse({success: true});
        return true;
    } else if (message.action === 'findFrameId') {
        // Get info about all frames in the tab
        chrome.webNavigation.getAllFrames({tabId: message.tabId})
            .then(frames => {
                console.log('All frames:', frames);

                // Find the frame that matches our video
                const targetFrame = frames.find(frame =>
                    frame.url.includes('vimeo.com') &&
                    (frame.url.includes(message.videoId) || frame.url.includes(message.videoSrc))
                );

                if (targetFrame) {
                    console.log('Found target frame:', targetFrame);
                    sendResponse({frameId: targetFrame.frameId});
                } else {
                    console.log('Target frame not found');
                    sendResponse({error: 'Frame not found'});
                }
            })
            .catch(error => {
                console.error('Error getting frames:', error);
                sendResponse({error: error.message});
            });

        return true;
    } else if (message.action === 'checkTranscriptOpen') {
        // Check if transcript panel is already open
        chrome.scripting.executeScript({
            target: {tabId: message.tabId, frameIds: [message.frameId]},
            function: checkTranscriptOpen
        })
            .then(results => {
                if (results && results[0] && results[0].result) {
                    sendResponse({isOpen: results[0].result.isOpen});
                } else {
                    sendResponse({isOpen: false});
                }
            })
            .catch(error => {
                console.error('Error checking transcript state:', error);
                sendResponse({isOpen: false});
            });

        return true;
    } else if (message.action === 'scrollToTop') {
        // Scroll transcript container to top
        chrome.scripting.executeScript({
            target: {tabId: message.tabId, frameIds: [message.frameId]},
            function: scrollTranscriptToTop
        })
            .then(() => {
                sendResponse({success: true});
            })
            .catch(error => {
                console.error('Error scrolling to top:', error);
                sendResponse({success: false, error: error.message});
            });

        return true;
    } else if (message.action === 'clickTranscriptButton') {
        // Execute script in the frame to click the transcript button
        chrome.scripting.executeScript({
            target: {tabId: message.tabId, frameIds: [message.frameId]},
            function: clickTranscriptButton
        })
            .then(results => {
                console.log('Script execution results:', results);
                if (results && results[0] && results[0].result && results[0].result.success) {
                    sendResponse({success: true});
                } else {
                    sendResponse({
                        success: false,
                        error: results && results[0] && results[0].result && results[0].result.error
                            ? results[0].result.error
                            : 'Failed to find transcript button'
                    });
                }
            })
            .catch(error => {
                console.error('Error executing script in iframe:', error);
                sendResponse({success: false, error: error.message});
            });

        return true;
    } else if (message.action === 'resetTranscriptPanel') {
        // Reset the transcript panel (close it) after capture
        chrome.scripting.executeScript({
            target: {tabId: message.tabId, frameIds: [message.frameId]},
            function: resetTranscriptPanel
        });

        return true;
    } else if (message.action === 'cancelCapture') {
        console.log('Background script received cancel request for frame:', message.frameId);

        // Execute script to cancel any active captures in the frame
        if (message.tabId && message.frameId !== undefined) {
            chrome.scripting.executeScript({
                target: {tabId: message.tabId, frameIds: [message.frameId]},
                function: cancelCaptureProcess
            })
                .then(() => {
                    console.log('Capture process cancelled in frame');
                    sendResponse({success: true});
                })
                .catch(error => {
                    console.error('Error cancelling capture:', error);
                    sendResponse({success: false, error: error.message});
                });

            return true;
        }

        sendResponse({success: true});
        return true;
    } else if (message.action === 'refreshPage') {
        // Refresh the page
        if (message.tabId) {
            chrome.tabs.reload(message.tabId);
            sendResponse({success: true});
        } else {
            sendResponse({success: false, error: 'No tab ID provided'});
        }
        return true;
    } else if (message.action === 'captureTranscriptContinuous') {
        console.log(`Starting transcript capture for: ${message.videoTitle}`);

        // Execute script to capture transcript with continuous scrolling
        chrome.scripting.executeScript({
            target: {tabId: message.tabId, frameIds: [message.frameId]},
            function: captureTranscriptContinuous,
            args: [message.videoTitle]
        })
            .then(results => {
                console.log('Transcript capture results:', results);
                if (results && results[0] && results[0].result && results[0].result.success) {
                    sendResponse({
                        success: true,
                        fileName: results[0].result.fileName,
                        text: results[0].result.text
                    });
                } else {
                    sendResponse({
                        success: false,
                        error: results && results[0] && results[0].result ?
                            results[0].result.error :
                            'Failed to capture transcript'
                    });
                }
            })
            .catch(error => {
                console.error('Error capturing transcript:', error);
                sendResponse({success: false, error: error.message});
            });

        return true;
    }
});

// Listen for tab updates to keep track of active tab
chrome.tabs.onActivated.addListener(activeInfo => {
    activeTabId = activeInfo.tabId;
});

// Listen for page navigation to scan for videos automatically
chrome.webNavigation.onCompleted.addListener((details) => {
    // Only run on main frame (not iframes)
    if (details.frameId === 0) {
        // Only run on Ridley College pages
        if (details.url.includes('ridley.edu.au')) {
            // Wait a moment for the page to fully load
            setTimeout(() => {
                // Send message to scan for videos
                chrome.tabs.sendMessage(details.tabId, {
                    action: 'autoScanForVideos'
                }).catch(error => {
                    console.log('Content script might not be ready yet:', error);
                });
            }, 1500);
        }
    }
}, {url: [{hostContains: 'ridley.edu.au'}]});

// Function to cancel any active capture processes
function cancelCaptureProcess() {
    console.log('Cancelling any active capture processes in this frame');

    // Find and clear all intervals (this is a broad approach)
    const highestIntervalId = window.setInterval(() => {
    }, 100000);
    for (let i = highestIntervalId; i >= 0; i--) {
        window.clearInterval(i);
    }

    // Find and clear all timeouts (also broad)
    const highestTimeoutId = window.setTimeout(() => {
    }, 100000);
    for (let i = highestTimeoutId; i >= 0; i--) {
        window.clearTimeout(i);
    }

    // Try to notify parent window that capture was cancelled
    try {
        window.parent.postMessage({
            action: 'transcriptProgress',
            processingState: 'cancelled'
        }, '*');
    } catch (e) {
        console.error('Error sending cancellation message:', e);
    }

    return {success: true};
}

// Function to check if transcript is already open
function checkTranscriptOpen() {
    try {
        // Method 1: Check for visible transcript container
        const transcriptContainer = document.getElementById('transcript-list') ||
            document.querySelector('ul[data-component-type="loaded-transcript"]');

        // Method 2: Check for any ul with transcript cues
        let hasVisibleTranscript = false;

        if (transcriptContainer && window.getComputedStyle(transcriptContainer).display !== 'none') {
            hasVisibleTranscript = true;
        } else {
            // Look for any visible ul that might be the transcript
            const allUlElements = document.querySelectorAll('ul');
            for (const ul of allUlElements) {
                if (window.getComputedStyle(ul).display !== 'none' &&
                    (ul.querySelector('[id^="transcript-cue-"]') ||
                        /\d{1,2}:\d{2}/.test(ul.textContent || ''))) {
                    hasVisibleTranscript = true;
                    break;
                }
            }
        }

        // Method 3: Check for transcript button state (might indicate if transcript is open)
        const buttons = Array.from(document.querySelectorAll('button'));
        const transcriptBtn = buttons.find(btn =>
            (btn.textContent && btn.textContent.toLowerCase().includes('transcript')) ||
            (btn.getAttribute('aria-label') && btn.getAttribute('aria-label').toLowerCase().includes('transcript'))
        );

        const buttonState = transcriptBtn ?
            (transcriptBtn.getAttribute('aria-pressed') === 'true' ||
                transcriptBtn.classList.contains('active') ||
                transcriptBtn.getAttribute('data-state') === 'active') : false;

        // Combine the results, prioritizing visual confirmation
        return {
            isOpen: hasVisibleTranscript || buttonState,
            containerVisible: hasVisibleTranscript,
            buttonState: buttonState
        };
    } catch (e) {
        console.error('Error checking transcript open state:', e);
        return {isOpen: false, error: e.message};
    }
}

// Function to scroll transcript to top
function scrollTranscriptToTop() {
    try {
        // Find transcript container
        const transcriptContainer = document.getElementById('transcript-list') ||
            document.querySelector('ul[data-component-type="loaded-transcript"]');

        // Find scrollable container
        let scrollContainer = null;

        // Method 1: Original selector
        scrollContainer = document.querySelector('.TranscriptList_lazy_module_listContainer__563e7abf');

        // Method 2: Get the parent of the transcript container
        if (!scrollContainer && transcriptContainer && transcriptContainer.parentElement) {
            const parent = transcriptContainer.parentElement;
            const style = window.getComputedStyle(parent);
            if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
                scrollContainer = parent;
            }
        }

        // Method 3: Find any parent with overflow: auto or scroll
        if (!scrollContainer && transcriptContainer) {
            let element = transcriptContainer;
            while (element.parentElement) {
                element = element.parentElement;
                const style = window.getComputedStyle(element);
                if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
                    scrollContainer = element;
                    break;
                }
            }
        }

        // If found, scroll to top
        if (scrollContainer) {
            console.log('Scrolling transcript to top');
            scrollContainer.scrollTo({top: 0, behavior: 'auto'});
            return {success: true};
        }

        return {success: false, message: 'Scroll container not found'};
    } catch (e) {
        console.error('Error scrolling to top:', e);
        return {success: false, error: e.message};
    }
}

// Function to click transcript button
function clickTranscriptButton() {
    console.log('Looking for transcript button in iframe...');

    try {
        // Function to find transcript buttons
        function findTranscriptButtons() {
            // Look for buttons with text or aria-label containing "transcript" or "cc"
            const buttons = Array.from(document.querySelectorAll('button'));

            console.log(`Found ${buttons.length} buttons in iframe`);

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

            return transcriptBtn;
        }

        // First check if buttons exist now
        let transcriptBtn = findTranscriptButtons();

        if (transcriptBtn) {
            console.log('Found transcript button immediately:', transcriptBtn);
            transcriptBtn.click();

            // Try to send a message back to the parent window
            try {
                window.parent.postMessage({
                    action: 'transcriptButtonClicked',
                    success: true
                }, '*');
            } catch (e) {
                console.error('Error sending message to parent:', e);
            }

            return {success: true};
        }

        // If not found immediately, try a few more times with delay
        for (let attempt = 0; attempt < 5; attempt++) {
            // Simulate delay
            const startTime = Date.now();
            while (Date.now() - startTime < 500) {
                // Busy wait
            }

            transcriptBtn = findTranscriptButtons();

            if (transcriptBtn) {
                console.log('Found transcript button on attempt', attempt + 1);
                transcriptBtn.click();

                // Try to send a message back to the parent window
                try {
                    window.parent.postMessage({
                        action: 'transcriptButtonClicked',
                        success: true
                    }, '*');
                } catch (e) {
                    console.error('Error sending message to parent:', e);
                }

                return {success: true};
            }
        }

        console.log('Failed to find transcript button after multiple attempts');
        return {success: false, error: 'Transcript button not found after multiple attempts'};
    } catch (error) {
        console.error('Error in clickTranscriptButton:', error);
        return {success: false, error: error.message};
    }
}

// Function to reset transcript panel
function resetTranscriptPanel() {
    try {
        // First scroll to top
        scrollTranscriptToTop();

        // Optional: Close the transcript panel
        // This is commented out because we might want to leave it open for user review
        /*
        const isOpen = checkTranscriptOpen();
        if (isOpen && isOpen.isOpen) {
          const transcriptBtn = findTranscriptButtons();
          if (transcriptBtn) {
            transcriptBtn.click();
          }
        }
        */

        return {success: true};
    } catch (e) {
        console.error('Error resetting transcript panel:', e);
        return {success: false, error: e.message};
    }
}

// Function to capture transcript with continuous scrolling
function captureTranscriptContinuous(videoTitle) {
    console.log('Capturing transcript for', videoTitle);

    try {
        // Flag for cancellation
        let isCancelled = false;

        // Add window event listener to detect cancellation messages
        const cancelListener = function (event) {
            if (event.data && event.data.action === 'transcriptProgress' &&
                event.data.processingState === 'cancelled') {
                console.log('Received cancellation message from parent');
                isCancelled = true;
            }
        };

        window.addEventListener('message', cancelListener);

        // Wait a bit for transcript to be visible
        const startWait = Date.now();
        while (Date.now() - startWait < 1000) {
            // Busy wait
        }

        // Try multiple selector methods to find the transcript container
        let transcriptContainer = null;

        // Method 1: Original selectors
        transcriptContainer = document.getElementById('transcript-list') ||
            document.querySelector('ul[data-component-type="loaded-transcript"]');

        // Method 2: Look for any ul with transcript cues
        if (!transcriptContainer) {
            const allUlElements = document.querySelectorAll('ul');
            const ulWithCues = Array.from(allUlElements).find(ul =>
                ul.querySelector('[id^="transcript-cue-"]')
            );

            if (ulWithCues) {
                console.log('Found transcript container via transcript cues');
                transcriptContainer = ulWithCues;
            }
        }

        // Method 3: Look for any ul with time stamps
        if (!transcriptContainer) {
            const allUlElements = document.querySelectorAll('ul');
            const ulWithTimeStamps = Array.from(allUlElements).find(ul => {
                const text = ul.textContent || '';
                return /\d{1,2}:\d{2}/.test(text);
            });

            if (ulWithTimeStamps) {
                console.log('Found transcript container via time stamps');
                transcriptContainer = ulWithTimeStamps;
            }
        }

        if (!transcriptContainer) {
            console.error('Transcript container not found');
            window.removeEventListener('message', cancelListener);
            return {success: false, error: 'Transcript container not found after trying multiple methods'};
        }

        console.log('Found transcript container:', transcriptContainer);

        // Find the scrollable container using multiple methods
        let scrollContainer = null;

        // Method 1: Original selector
        scrollContainer = document.querySelector('.TranscriptList_lazy_module_listContainer__563e7abf');

        // Method 2: Get the parent of the transcript container
        if (!scrollContainer && transcriptContainer.parentElement) {
            const parent = transcriptContainer.parentElement;
            const style = window.getComputedStyle(parent);
            if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
                console.log('Using parent as scroll container');
                scrollContainer = parent;
            }
        }

        // Method 3: Find any parent with overflow: auto or scroll
        if (!scrollContainer) {
            let element = transcriptContainer;
            while (element.parentElement) {
                element = element.parentElement;
                const style = window.getComputedStyle(element);
                if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
                    console.log('Found scroll container ancestor');
                    scrollContainer = element;
                    break;
                }
            }
        }

        // Method 4: Just use document.body as a last resort
        if (!scrollContainer) {
            console.log('Using body as scroll container');
            scrollContainer = document.body;
        }

        console.log('Using scroll container:', scrollContainer);

        // First scroll to top to ensure we capture everything
        scrollContainer.scrollTo({top: 0});

        // Initialize transcript data
        const transcriptData = {};

        // Track the latest timestamp we've seen and estimated video duration
        let latestTimestamp = 0; // In seconds
        let estimatedDuration = 0; // In seconds

        // Function to extract seconds from a timestamp string
        function timestampToSeconds(timestamp) {
            if (!timestamp) return 0;

            // Match MM:SS or HH:MM:SS format
            const match = timestamp.match(/(?:(\d+):)?(\d+):(\d+)/);
            if (!match) return 0;

            if (match[1]) {
                // HH:MM:SS format
                return (parseInt(match[1]) * 3600) + (parseInt(match[2]) * 60) + parseInt(match[3]);
            } else {
                // MM:SS format
                return (parseInt(match[2]) * 60) + parseInt(match[3]);
            }
        }

        // Function to extract timestamps from text
        function extractTimestamp(text) {
            if (!text) return null;

            // Look for timestamp pattern at the beginning of the string
            const match = text.match(/^(?:\[)?(\d+:\d+(?::\d+)?)(?:\])?/);
            return match ? match[1] : null;
        }

        // Send initial progress signal
        try {
            window.parent.postMessage({
                action: 'transcriptProgress',
                segments: 0,
                progress: 0,
                hasStarted: true
            }, '*');
        } catch (e) {
            console.error('Error sending initial progress message:', e);
        }

        // Function to scan for cues
        function scanForCues() {
            // Check if cancelled
            if (isCancelled) return {segmentCount: 0, newSegmentsFound: false};

            // Method 1: Original selector for cues
            let cues = transcriptContainer.querySelectorAll('[id^="transcript-cue-"]');

            // Method 2: If no cues found, try li elements
            if (!cues || cues.length === 0) {
                cues = transcriptContainer.querySelectorAll('li');
            }

            // Count segments before we capture
            const previousSegmentCount = Object.keys(transcriptData).length;

            // Capture cues
            cues.forEach((cue, index) => {
                const id = cue.id || `custom-cue-${index}`;
                const text = cue.innerText.trim();

                // Only store if we haven't captured this one before
                if (!transcriptData[id]) {
                    transcriptData[id] = text;

                    // Try to extract timestamp
                    const timestamp = extractTimestamp(text);
                    if (timestamp) {
                        const seconds = timestampToSeconds(timestamp);
                        if (seconds > latestTimestamp) {
                            latestTimestamp = seconds;
                        }
                        if (seconds > estimatedDuration) {
                            // Assume this video is at least 20% longer than the current timestamp
                            estimatedDuration = Math.ceil(seconds * 1.2);
                        }
                    }
                }
            });

            const currentSegmentCount = Object.keys(transcriptData).length;
            const newSegmentsFound = currentSegmentCount > previousSegmentCount;

            // Calculate progress based on timestamp if available
            let progressValue = 0;

            if (estimatedDuration > 0 && latestTimestamp > 0) {
                // Using timestamp-based progress
                progressValue = Math.min(latestTimestamp / estimatedDuration, 0.99);
            } else {
                // Fallback to scroll-based progress
                progressValue = Math.min(
                    scrollContainer.scrollTop / (scrollContainer.scrollHeight - scrollContainer.clientHeight || 1),
                    0.99
                );
            }

            // Report progress
            try {
                window.parent.postMessage({
                    action: 'transcriptProgress',
                    segments: currentSegmentCount,
                    progress: progressValue,
                    hasNewSegments: newSegmentsFound,
                    latestTimestamp: latestTimestamp,
                    estimatedDuration: estimatedDuration
                }, '*');
            } catch (e) {
                console.error('Error sending progress message:', e);
            }

            return {
                segmentCount: currentSegmentCount,
                newSegmentsFound: newSegmentsFound
            };
        }

        // Scan initially
        scanForCues();

        // Calculate adaptive scroll step based on container width
        const containerWidth = scrollContainer.clientWidth || window.innerWidth;
        // This makes it scroll faster on bigger screens
        let scrollStep = Math.max(120, Math.min(400, 225 + (containerWidth / 5)));

        console.log(`Adaptive scroll step calculated: ${scrollStep}px for container width: ${containerWidth}px`);

        // Set up continuous scrolling with frequent scanning
        let lastScrollTop = -1;
        let lastSegmentCount = 0;
        let noChangeCount = 0;
        let scrollAttempt = 0;
        const scanInterval = 250; // More frequent scanning
        const maxScrollAttempts = 250; // Maximum attempts to prevent infinite loops

        return new Promise((resolve) => {
            // Set a timeout to ensure we don't get stuck
            const timeoutId = setTimeout(() => {
                console.log('Timeout reached, finishing capture');
                if (scrollIntervalId) {
                    clearInterval(scrollIntervalId);
                    completeCapture('timeout');
                }
            }, 45000); // 45 second safety timeout

            const scrollIntervalId = setInterval(() => {
                // Check if we've been cancelled
                if (isCancelled) {
                    console.log('Capture was cancelled, stopping scroll interval');
                    clearInterval(scrollIntervalId);
                    clearTimeout(timeoutId);
                    window.removeEventListener('message', cancelListener);
                    resolve({success: false, error: 'Capture cancelled'});
                    return;
                }

                // Scroll down a bit
                scrollContainer.scrollBy({top: scrollStep, behavior: 'smooth'});

                // Scan for new cues
                const scanResult = scanForCues();
                const segmentCount = scanResult.segmentCount;
                const foundNewSegments = scanResult.newSegmentsFound;

                // Check if we've reached the end (3 methods)

                // Method 1: No scroll change
                const reachedEnd1 = scrollContainer.scrollTop === lastScrollTop;

                // Method 2: Near bottom
                const scrollBottom = scrollContainer.scrollTop + scrollContainer.clientHeight;
                const reachedEnd2 = scrollBottom >= scrollContainer.scrollHeight - 10; // Within 10px of bottom

                // Method 3: No new segments for a while
                const reachedEnd3 = segmentCount === lastSegmentCount && segmentCount > 0;

                if ((reachedEnd1 || reachedEnd2) && reachedEnd3) {
                    noChangeCount++;
                    if (noChangeCount >= 3) {
                        // No more content to load - we're done
                        clearInterval(scrollIntervalId);
                        clearTimeout(timeoutId);
                        completeCapture('reached-end');
                    }
                } else {
                    noChangeCount = 0;
                }

                // Track values for next iteration
                lastScrollTop = scrollContainer.scrollTop;
                lastSegmentCount = segmentCount;

                // Safety limit - don't run forever
                scrollAttempt++;
                if (scrollAttempt >= maxScrollAttempts) {
                    clearInterval(scrollIntervalId);
                    clearTimeout(timeoutId);
                    completeCapture('max-attempts');
                }
            }, scanInterval);

            // Function to complete the capture process
            function completeCapture(reason) {
                console.log(`Capture complete, reason: ${reason}`);

                // Check if we've been cancelled
                if (isCancelled) {
                    console.log('Capture was cancelled, skipping completion');
                    window.removeEventListener('message', cancelListener);
                    resolve({success: false, error: 'Capture cancelled'});
                    return;
                }

                // Transition to processing phase
                try {
                    window.parent.postMessage({
                        action: 'transcriptProgress',
                        processingState: 'processing',
                        // Do not set progress to 100% yet
                    }, '*');
                } catch (e) {
                    console.error('Error sending final progress message:', e);
                }

                // Process the transcript text with a small delay
                setTimeout(() => {
                    processAndDownload();
                }, 500);
            }

            // Process and download the captured transcript
            function processAndDownload() {
                try {
                    // Check if we've been cancelled
                    if (isCancelled) {
                        console.log('Capture was cancelled, skipping download');
                        window.removeEventListener('message', cancelListener);
                        resolve({success: false, error: 'Capture cancelled'});
                        return;
                    }

                    console.log('Processing transcript data...');

                    // Process the transcript data
                    let transcriptText = '';

                    // Sort keys if they're numbered
                    const sortedKeys = Object.keys(transcriptData).sort((a, b) => {
                        if (a.startsWith('transcript-cue-') && b.startsWith('transcript-cue-')) {
                            return parseInt(a.replace('transcript-cue-', '')) - parseInt(b.replace('transcript-cue-', ''));
                        } else if (a.startsWith('custom-cue-') && b.startsWith('custom-cue-')) {
                            return parseInt(a.replace('custom-cue-', '')) - parseInt(b.replace('custom-cue-', ''));
                        }
                        return 0;
                    });

                    transcriptText = sortedKeys.map(key => transcriptData[key]).join('\n');

                    // Remove standalone timestamps and clean up
                    transcriptText = transcriptText
                        .split('\n')
                        .filter(line => !/^\d{1,2}:\d{2}$/.test(line.trim()))
                        .join('\n');

                    // Signal formatting stage - without setting progress to 100%
                    try {
                        window.parent.postMessage({
                            action: 'transcriptProgress',
                            processingState: 'formatting'
                        }, '*');
                    } catch (e) {
                        console.error('Error sending processing message:', e);
                    }

                    // Define the improve text formatting function inline
                    function improveTextFormatting(text) {
                        console.log("Starting text formatting...");
                        const startTime = performance.now();

                        // Step 1: Remove duplicate lines and empty lines
                        const lines = text.split('\n');
                        const filteredLines = [];
                        const seen = new Set();

                        for (const line of lines) {
                            const trimmed = line.trim();
                            if (trimmed && !seen.has(trimmed)) {
                                seen.add(trimmed);
                                filteredLines.push(trimmed);
                            }
                        }

                        console.log(`Removed duplicates: ${lines.length} -> ${filteredLines.length} lines`);

                        // Step 2: Intelligently merge broken sentences
                        let mergedText = '';
                        let currentSentence = '';

                        for (let i = 0; i < filteredLines.length; i++) {
                            const line = filteredLines[i];

                            // If line ends with sentence-ending punctuation, consider it complete
                            if (/[.!?]$/.test(line)) {
                                // Complete sentence - add it and start a new one
                                if (currentSentence) {
                                    mergedText += currentSentence + ' ' + line + '\n';
                                    currentSentence = '';
                                } else {
                                    mergedText += line + '\n';
                                }
                            }
                            // If line starts with lowercase or doesn't end with punctuation, likely continuation
                            else if (/^[a-z]/.test(line) || !/[.!?,;:]$/.test(line)) {
                                // Continuation of sentence
                                currentSentence += (currentSentence ? ' ' : '') + line;
                            }
                            // New sentence (starts with uppercase)
                            else {
                                // If we have a partial sentence, add it first
                                if (currentSentence) {
                                    mergedText += currentSentence + '\n';
                                }
                                // Start new accumulation
                                currentSentence = line;
                            }
                        }

                        // Add any remaining partial sentence
                        if (currentSentence) {
                            mergedText += currentSentence;
                        }

                        // Step 3: Remove any extra whitespace or line breaks
                        const finalText = mergedText.trim()
                            .replace(/\n{3,}/g, '\n\n') // No more than 2 consecutive line breaks
                            .replace(/[ \t]+/g, ' '); // No extra spaces

                        const endTime = performance.now();
                        console.log(`Text formatting completed in ${(endTime - startTime).toFixed(0)}ms`);

                        return finalText;
                    }

                    // Call the function to improve text formatting
                    transcriptText = improveTextFormatting(transcriptText);

                    // Signal saving stage - still not 100%
                    try {
                        window.parent.postMessage({
                            action: 'transcriptProgress',
                            processingState: 'saving'
                        }, '*');
                    } catch (e) {
                        console.error('Error sending saving message:', e);
                    }

                    console.log('Final transcript length:', transcriptText.length);

                    // Sanitize filename and ensure it has an extension
                    let fileName = videoTitle;
                    if (!fileName.endsWith('.txt')) {
                        fileName += '.txt';
                    }

                    // Send completion message before triggering download
                    try {
                        window.parent.postMessage({
                            action: 'transcriptProgress',
                            processingState: 'complete',
                            progress: 1.0
                        }, '*');
                    } catch (e) {
                        console.error('Error sending completion message:', e);
                    }

                    // Cleanup event listener
                    window.removeEventListener('message', cancelListener);

                    // Add a small delay to ensure UI shows 100% before download appears
                    setTimeout(() => {
                        // Final cancellation check before download
                        if (isCancelled) {
                            console.log('Capture was cancelled at final step, skipping download');
                            resolve({success: false, error: 'Capture cancelled'});
                            return;
                        }

                        // Create a download
                        const blob = new Blob([transcriptText], {type: 'text/plain'});
                        const url = URL.createObjectURL(blob);

                        const a = document.createElement('a');
                        a.href = url;
                        a.download = fileName;
                        document.body.appendChild(a);
                        a.click();
                        document.body.removeChild(a);
                    }, 500); // Longer delay to ensure progress bar completes

                    resolve({
                        success: true,
                        fileName: fileName,
                        text: transcriptText
                    });
                } catch (error) {
                    window.removeEventListener('message', cancelListener);
                    console.error('Error processing transcript:', error);
                    resolve({success: false, error: 'Error processing transcript: ' + error.message});
                }
            }
        });
    } catch (e) {
        console.error('Error capturing transcript:', e);
        return {success: false, error: e.message};
    }
}