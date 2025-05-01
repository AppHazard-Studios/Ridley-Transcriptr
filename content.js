// This runs on the Moodle page to find videos and handle transcript extraction
console.log('Ridley Transcriptr loaded');

// Store detected videos
let detectedVideos = [];
let activeCapture = null;
let processedDownloads = new Set(); // Track processed downloads to prevent duplicates
let shouldRefreshAllIframes = false; // Flag to indicate if all iframes need refresh

// Function to detect videos on the Moodle page
function scanForVideos() {
    detectedVideos = [];

    // Look for iframe elements that point to Vimeo
    const iframes = document.querySelectorAll('iframe[src*="vimeo"]');
    console.log(`Found ${iframes.length} Vimeo iframes`);

    iframes.forEach((iframe, index) => {
        // Extract the video ID from the src attribute
        const src = iframe.src;
        const videoId = extractVimeoId(src);

        if (!videoId) return;

        // Try to determine the title of the video from various sources
        let title = '';

        // 1. Check the iframe's title attribute
        if (iframe.title) {
            title = iframe.title;
        }

        // 2. Check for heading elements near the iframe
        if (!title || title.trim() === '') {
            // Look up to 3 parent elements to find potential headings
            let parent = iframe.parentElement;
            let searchDepth = 0;
            while (parent && searchDepth < 3) {
                // Look for heading elements before the iframe
                const headings = parent.querySelectorAll('h1, h2, h3, h4, h5, h6');
                if (headings.length > 0) {
                    // Use the closest heading before the iframe
                    for (let i = 0; i < headings.length; i++) {
                        if (headings[i].compareDocumentPosition(iframe) & Node.DOCUMENT_POSITION_FOLLOWING) {
                            title = headings[i].textContent.trim();
                            break;
                        }
                    }
                    if (title) break;
                }
                parent = parent.parentElement;
                searchDepth++;
            }
        }

        // 3. If still no title, check for an img element with alt text near the iframe
        if (!title || title.trim() === '') {
            const parentElement = iframe.parentElement;
            if (parentElement) {
                const images = parentElement.querySelectorAll('img[alt]');
                if (images.length > 0) {
                    title = images[0].alt;
                }
            }
        }

        // 4. Default title if nothing else was found
        if (!title || title.trim() === '') {
            title = `Video ${index + 1}`;
        }

        // Clean up title - remove "from Ridley College on Vimeo" if present
        title = title.replace(/from\s+Ridley College on Vimeo/gi, "");
        title = title.replace(/Ridley College on Vimeo/gi, "");
        title = title.replace(/from/gi, "");
        title = title.trim();

        // Create sanitized filename-friendly version of the title
        const sanitizedTitle = sanitizeFilename(title);

        detectedVideos.push({
            id: index,
            videoId: videoId,
            iframe: iframe,
            src: src,
            title: title,
            filename: sanitizedTitle
        });

        console.log(`Detected video: ${title}, ID: ${videoId}`);
    });

    // Update the badge with the number of detected videos
    if (detectedVideos.length > 0) {
        chrome.runtime.sendMessage({
            action: 'updateBadge',
            count: detectedVideos.length
        });
    } else {
        chrome.runtime.sendMessage({
            action: 'updateBadge',
            count: 0
        });
    }

    return detectedVideos;
}

// Extract Vimeo ID from URL
function extractVimeoId(url) {
    const match = url.match(/(?:vimeo\.com\/(?:video\/)?|player\.vimeo\.com\/video\/)([0-9]+)/);
    return match ? match[1] : null;
}

// Sanitize filename
function sanitizeFilename(name) {
    let sanitized = name.replace(/[\\\/:*?"<>|]/g, '_');
    sanitized = sanitized.replace(/\s+/g, ' ');
    sanitized = sanitized.trim();

    if (sanitized.length > 50) {
        sanitized = sanitized.substring(0, 50).trim();
    }

    if (!sanitized) sanitized = "vimeo_transcript";

    return sanitized;
}

// Function to reload all video iframes without refreshing the page
function reloadAllVideoIframes(focusVideoAfterReload = null) {
    console.log('Reloading all video iframes');

    let refreshedCount = 0;
    detectedVideos.forEach(video => {
        if (video.iframe) {
            if (reloadIframe(video.iframe, video === focusVideoAfterReload)) {
                refreshedCount++;
            }
        }
    });

    shouldRefreshAllIframes = false; // Reset the flag
    console.log(`Refreshed ${refreshedCount} iframes`);

    // Explicitly focus the specified video if provided
    if (focusVideoAfterReload && focusVideoAfterReload.iframe) {
        // Schedule this with a slight delay to ensure it happens after all reloads
        setTimeout(() => {
            console.log(`Focusing on video: ${focusVideoAfterReload.title} after refresh`);
            focusVideoAfterReload.iframe.scrollIntoView({behavior: 'smooth', block: 'center'});
        }, 1000);
    }

    return refreshedCount > 0;
}

// Cancel the active capture if one exists
function cancelActiveCapture() {
    if (activeCapture) {
        console.log('Cancelling active capture');

        // Mark as cancelled to prevent any pending callbacks from continuing
        if (!activeCapture.cancelled) {
            activeCapture.cancelled = true;
        }

        // Get tabId and frameId if available
        const tabId = activeCapture.tabId;
        const frameId = activeCapture.frameId;

        // Tell the background script to cancel any capture processes
        if (tabId && frameId !== undefined) {
            chrome.runtime.sendMessage({
                action: 'cancelCapture',
                tabId: tabId,
                frameId: frameId
            });
        }

        // Clean up observer if it exists
        if (activeCapture.observer) {
            activeCapture.observer.disconnect();
            activeCapture.observer = null;
        }

        // Clear any intervals
        if (activeCapture.scrollInterval) {
            clearInterval(activeCapture.scrollInterval);
            activeCapture.scrollInterval = null;
        }

        // Cancel any animation frames
        if (activeCapture.progressAnimation) {
            cancelAnimationFrame(activeCapture.progressAnimation);
            activeCapture.progressAnimation = null;
        }

        // Remove the progress state and its callbacks
        if (activeCapture.progressState) {
            if (activeCapture.progressState.animationId) {
                cancelAnimationFrame(activeCapture.progressState.animationId);
            }
            activeCapture.progressState = null;
        }

        // Remove the overlay if it exists and isn't a batch overlay
        if (activeCapture.overlay && !activeCapture.isBatchProcess) {
            removeOverlay(activeCapture.overlay);
            activeCapture.overlay = null;
        }

        // Remove message listener
        if (activeCapture.messageListener) {
            window.removeEventListener('message', activeCapture.messageListener);
        }

        // Clear all references
        activeCapture = null;
    }
}

// Function to reload an iframe without refreshing the page
function reloadIframe(iframe, shouldFocus = false) {
    if (!iframe) return false;

    try {
        // Store the original src
        const originalSrc = iframe.src;

        // Set a blank src then restore the original
        iframe.src = 'about:blank';

        // Wait a short moment then restore the src
        setTimeout(() => {
            iframe.src = originalSrc;

            // Ensure it's fully visible if requested
            if (shouldFocus) {
                iframe.scrollIntoView({behavior: 'smooth', block: 'center'});
            }

            console.log('Iframe reloaded:', originalSrc);
        }, 500);

        return true;
    } catch (error) {
        console.error('Error reloading iframe:', error);
        return false;
    }
}

// Function to process a video to extract its transcript
function processVideoTranscript(videoInfo, callback, batchProcess = null) {
    console.log(`Processing transcript for: ${videoInfo.title}${batchProcess ? ' (batch process)' : ''}`);

    // Cancel any existing capture
    cancelActiveCapture();

    // Scroll to the video iframe
    videoInfo.iframe.scrollIntoView({behavior: 'smooth', block: 'center'});

    // Create an overlay to show progress or use the batch overlay
    const overlay = batchProcess || createOverlay(videoInfo.title);

    // If we're in a batch process, update the overlay title and message
    if (batchProcess) {
        if (overlay.title && overlay.batchInfo) {
            const currentVideo = overlay.batchInfo.currentIndex + 1;
            const totalVideos = overlay.batchInfo.totalVideos;
            overlay.title.textContent = `Processing "${videoInfo.title}" (${currentVideo}/${totalVideos})`;
        }
        if (overlay.message) {
            overlay.message.textContent = "Preparing for transcript capture...";
        }
    }

    // Initialize progress variables
    const progressState = {
        value: 0,           // Current displayed progress (0-1)
        target: 0.02,       // Target progress to smoothly animate toward
        speed: 0.0005,      // Base speed (adjusted dynamically)
        message: "Preparing for transcript capture...",
        animationId: null,
        complete: false,
        captureStarted: false,
        actualProgress: 0,   // Actual progress from transcript capture
        estimatedDuration: 60 * 5,  // Estimated duration in seconds (default 5 minutes)
        completionTime: null, // Timestamp when process was completed
        refreshAttempted: false  // Track if we've attempted a refresh for this video
    };

    // Start with 0% progress
    updateOverlayProgress(overlay, 0, progressState.message);

    // Create the message handler function
    const handleIframeMessage = function (event) {
        // Make sure we still have an active capture
        if (!activeCapture || activeCapture.cancelled) return;

        // Check if the message is from our injected script
        if (event.data && event.data.action === 'transcriptButtonClicked') {
            console.log('Received message from iframe:', event.data);

            if (event.data.success) {
                progressState.target = 0.2;
                progressState.message = "Transcript opened successfully";
                if (overlay.message) {
                    overlay.message.textContent = progressState.message;
                }
            } else {
                progressState.message = `Error: ${event.data.error || 'Unknown error'}`;
                if (overlay.message) {
                    overlay.message.textContent = progressState.message;
                }
                handleFailure(event.data.error || 'Failed to open transcript');
            }
        } else if (event.data && event.data.action === 'transcriptProgress') {
            // Update progress from the iframe

            // If capture has started
            if (progressState.captureStarted) {
                // Check if we're in a specific state
                if (event.data.processingState === 'processing') {
                    progressState.message = "Processing transcript text...";
                    if (overlay.message) {
                        overlay.message.textContent = progressState.message;
                    }
                    progressState.target = 0.97; // Start filling the last bit
                } else if (event.data.processingState === 'formatting') {
                    progressState.message = "Formatting transcript text...";
                    if (overlay.message) {
                        overlay.message.textContent = progressState.message;
                    }
                    progressState.target = 0.98;
                } else if (event.data.processingState === 'saving') {
                    progressState.message = "Preparing download...";
                    if (overlay.message) {
                        overlay.message.textContent = progressState.message;
                    }
                    progressState.target = 0.99;
                } else if (event.data.processingState === 'complete') {
                    // Signal completion - will reach 100% and trigger download after delay
                    progressState.message = "Transcript download complete!";
                    if (overlay.message) {
                        overlay.message.textContent = progressState.message;
                    }
                    progressState.complete = true;
                } else if (event.data.processingState === 'cancelled') {
                    console.log('Received cancellation message from iframe');
                    if (activeCapture) {
                        activeCapture.cancelled = true;
                    }
                } else if (event.data.segments !== undefined) {
                    // Regular progress updates during capture

                    // Update the message with segment count
                    progressState.message = `Segments captured: ${event.data.segments}`;
                    if (overlay.message) {
                        overlay.message.textContent = progressState.message;
                    }

                    // Update actual progress if available
                    if (event.data.progress !== undefined) {
                        progressState.actualProgress = event.data.progress;
                    }

                    // Update estimated duration if available
                    if (event.data.estimatedDuration && event.data.estimatedDuration > 0) {
                        progressState.estimatedDuration = event.data.estimatedDuration;
                    }
                }
            }
        }
    };

    // Only add cancel button if not a batch process (batch has its own cancel)
    if (!batchProcess) {
        addOverlayButton(overlay, "Cancel", () => {
            // Ensure we remove event listener before calling cancel
            window.removeEventListener('message', handleIframeMessage);
            cancelActiveCapture();
            if (callback) callback({success: false, error: "Capture cancelled by user"});
        }, "secondary");
    }

    // Start smooth linear progress animation
    function animateProgress() {
        // If we're cancelled, stop immediately
        if (!activeCapture || activeCapture.cancelled) {
            return;
        }

        // If we need to complete immediately
        if (progressState.complete && !progressState.completionTime) {
            progressState.value = 1.0;
            if (overlay && overlay.progressBar) {
                overlay.progressBar.style.width = '100%';
            }
            progressState.completionTime = Date.now();
            progressState.animationId = requestAnimationFrame(animateProgress);
            return;
        }

        // If completed and waiting for download delay
        if (progressState.completionTime) {
            // Wait for a bit then we're done with animation
            if (Date.now() - progressState.completionTime >= 2000) {
                cancelAnimationFrame(progressState.animationId);
                return;
            }

            // Continue animation if we're still active
            if (!activeCapture.cancelled) {
                progressState.animationId = requestAnimationFrame(animateProgress);
            }
            return;
        }

        // Normal progress animation
        if (progressState.value < progressState.target) {
            // Calculate how fast to move based on how much progress is left
            // Start slower, gradually increase speed, then slow down at the end
            let speedMultiplier;

            if (progressState.target < 0.2) {
                // Initial phase - slower, deliberate progress
                speedMultiplier = 0.01;
            } else if (progressState.captureStarted) {
                // Transcript capture phase - steady, medium speed
                // Use a linear progression that would fill the whole bar in ~60 seconds
                const timeBasedTarget = Math.min(0.2 + ((Date.now() - progressState.captureStart) / 60000), 0.95);

                // If actual progress is ahead of our time-based target, follow actual progress
                if (progressState.actualProgress > timeBasedTarget) {
                    progressState.target = Math.min(0.2 + (progressState.actualProgress * 0.75), 0.95);
                } else {
                    // Otherwise use time-based progression
                    progressState.target = timeBasedTarget;
                }

                speedMultiplier = 0.015;
            } else {
                // Preparation phase - medium speed
                speedMultiplier = 0.01;
            }

            // Apply speed with dynamic adjustment
            const increment = progressState.speed * speedMultiplier * (100 - progressState.value * 50);
            progressState.value += increment;

            // Prevent overshooting the target
            if (progressState.value > progressState.target) {
                progressState.value = progressState.target;
            }

            // Update the visible progress bar - smoothly rounded to 2 decimal places
            if (overlay && overlay.progressBar) {
                overlay.progressBar.style.width = `${Math.round(progressState.value * 10000) / 100}%`;
            }
        }

        // Continue animation if we're still active
        if (!activeCapture || !activeCapture.cancelled) {
            progressState.animationId = requestAnimationFrame(animateProgress);
        }
    }

    // Start the animation
    progressState.animationId = requestAnimationFrame(animateProgress);

    // Set up message listener for communication from the iframe
    window.addEventListener('message', handleIframeMessage);

    // Store the active capture details
    activeCapture = {
        overlay: overlay,
        videoInfo: videoInfo,
        cancelled: false,
        observer: null,
        scrollInterval: null,
        progressState: progressState,
        progressAnimation: progressState.animationId,
        messageListener: handleIframeMessage, // Store reference for cleanup
        tabId: null,
        frameId: null,
        isBatchProcess: !!batchProcess,  // Flag to indicate if this is part of a batch
        videoId: videoInfo.id            // Store the specific video ID being processed
    };

    // Get the iframe source URL for later use
    const iframeSrc = videoInfo.iframe.src;
    const videoId = videoInfo.videoId;

    // Function to start the capture process
    function startCapture() {
        // Update progress target to 5%
        progressState.target = 0.05;
        progressState.message = "Accessing video player...";
        if (overlay.message) {
            overlay.message.textContent = progressState.message;
        }

        // First, ensure we have focus on the tab
        if (document.hasFocus() === false) {
            // Try to focus the window
            window.focus();
        }

        // Get the tab ID for later use with chrome.scripting
        chrome.runtime.sendMessage({action: 'getTabId'}, response => {
            // Check if we've been cancelled before the callback
            if (!activeCapture || activeCapture.cancelled) return;

            if (response && response.tabId) {
                const tabId = response.tabId;
                // Store tabId in activeCapture for cancellation
                activeCapture.tabId = tabId;

                // Update progress target to 10%
                progressState.target = 0.1;
                progressState.message = "Finding video frame...";
                if (overlay.message) {
                    overlay.message.textContent = progressState.message;
                }

                // Find which frameId corresponds to our iframe
                chrome.runtime.sendMessage({
                    action: 'findFrameId',
                    tabId: tabId,
                    videoSrc: iframeSrc,
                    videoId: videoId
                }, response => {
                    // Check if we've been cancelled before the callback
                    if (!activeCapture || activeCapture.cancelled) return;

                    if (response && response.frameId !== undefined) {
                        const frameId = response.frameId;
                        // Store frameId in activeCapture for cancellation
                        activeCapture.frameId = frameId;
                        console.log(`Found frame ID: ${frameId} for video ${videoInfo.title}`);

                        // Update progress target to 15%
                        progressState.target = 0.15;
                        progressState.message = "Checking transcript status...";
                        if (overlay.message) {
                            overlay.message.textContent = progressState.message;
                        }

                        // First check if transcript is already open
                        chrome.runtime.sendMessage({
                            action: 'checkTranscriptOpen',
                            tabId: tabId,
                            frameId: frameId
                        }, response => {
                            // Check if we've been cancelled before the callback
                            if (!activeCapture || activeCapture.cancelled) return;

                            const transcriptAlreadyOpen = response && response.isOpen;

                            if (transcriptAlreadyOpen) {
                                console.log('Transcript is already open');

                                // Update progress target to 20%
                                progressState.target = 0.2;
                                progressState.message = "Transcript is already open";
                                if (overlay.message) {
                                    overlay.message.textContent = progressState.message;
                                }

                                chrome.runtime.sendMessage({
                                    action: 'scrollToTop',
                                    tabId: tabId,
                                    frameId: frameId
                                }, () => {
                                    // Check if we've been cancelled before the callback
                                    if (!activeCapture || activeCapture.cancelled) return;

                                    startTranscriptCapture(tabId, frameId);
                                });
                            } else {
                                // Need to click the transcript button first
                                progressState.target = 0.15;
                                progressState.message = "Opening transcript panel...";
                                if (overlay.message) {
                                    overlay.message.textContent = progressState.message;
                                }

                                chrome.runtime.sendMessage({
                                    action: 'clickTranscriptButton',
                                    tabId: tabId,
                                    frameId: frameId
                                }, response => {
                                    // Check if we've been cancelled before the callback
                                    if (!activeCapture || activeCapture.cancelled) return;

                                    if (response && response.success) {
                                        progressState.target = 0.2;
                                        progressState.message = "Transcript opened successfully";
                                        if (overlay.message) {
                                            overlay.message.textContent = progressState.message;
                                        }

                                        // Wait a bit for the transcript to appear
                                        setTimeout(() => {
                                            // Check if we've been cancelled during timeout
                                            if (!activeCapture || activeCapture.cancelled) return;
                                            startTranscriptCapture(tabId, frameId);
                                        }, 1000);
                                    } else {
                                        // If button click failed, refresh the iframes
                                        if (!progressState.refreshAttempted) {
                                            progressState.refreshAttempted = true;
                                            refreshAndRetry("Button click failed", videoInfo);
                                        } else {
                                            handleFailure("Failed to open transcript panel even after refresh");
                                        }
                                    }
                                });
                            }
                        });
                    } else {
                        // Frame not found - refresh all iframes
                        if (!progressState.refreshAttempted) {
                            progressState.refreshAttempted = true;
                            refreshAndRetry("Frame not found", videoInfo);
                        } else {
                            handleFailure("Could not find video frame even after refresh");
                        }
                    }
                });
            } else {
                // Tab ID not found - refresh all iframes
                if (!progressState.refreshAttempted) {
                    progressState.refreshAttempted = true;
                    refreshAndRetry("Tab ID not found", videoInfo);
                } else {
                    handleFailure("Could not get tab ID even after refresh");
                }
            }
        });
    }

    // Handle iframe refresh and retry
    function refreshAndRetry(reason, videoInfo) {
        console.log(`Refreshing iframes due to: ${reason}`);

        // Set global flag that all iframes need refresh
        shouldRefreshAllIframes = true;

        progressState.message = `Refreshing video players... (${reason})`;
        if (overlay.message) {
            overlay.message.textContent = progressState.message;
        }

        // Refresh this specific iframe first (for immediate visibility)
        reloadIframe(videoInfo.iframe, true);

        // Wait a bit, then refresh all iframes
        setTimeout(() => {
            // Check if we've been cancelled during timeout
            if (!activeCapture || activeCapture.cancelled) return;

            // Refresh all iframes but ensure we focus on the current video we're processing
            reloadAllVideoIframes(videoInfo);

            progressState.message = "Waiting for video players to reload...";
            if (overlay.message) {
                overlay.message.textContent = progressState.message;
            }

            // Wait for iframes to finish reloading
            setTimeout(() => {
                // Check if we've been cancelled during timeout
                if (!activeCapture || activeCapture.cancelled) return;

                // Make sure we're focused on the current video
                videoInfo.iframe.scrollIntoView({behavior: 'smooth', block: 'center'});

                progressState.message = "Retrying transcript capture...";
                if (overlay.message) {
                    overlay.message.textContent = progressState.message;
                }

                // Reset progress
                progressState.target = 0.05;

                // Try again from the beginning
                setTimeout(() => {
                    // Try again with the same video
                    startCapture();
                }, 1000);
            }, 2000);
        }, 500);
    }

    // Start the capture process
    if (shouldRefreshAllIframes && !progressState.refreshAttempted) {
        // If we know iframe refresh is needed, do it first
        refreshAndRetry("Preemptive refresh", videoInfo);
    } else {
        // Otherwise start normally
        startCapture();
    }

    // Function to start the actual capturing process
    function startTranscriptCapture(tabId, frameId) {
        // Store these in activeCapture if not already there
        if (activeCapture) {
            activeCapture.tabId = tabId;
            activeCapture.frameId = frameId;
        }

        // Start capturing the transcript with continuous scrolling
        progressState.target = 0.2;
        progressState.message = "Starting transcript capture...";
        progressState.captureStarted = true;
        progressState.captureStart = Date.now();
        if (overlay.message) {
            overlay.message.textContent = progressState.message;
        }

        // We'll use a direct approach - trigger the capture once
        // and let the progress bar animate to completion
        chrome.runtime.sendMessage({
            action: 'captureTranscriptContinuous',
            tabId: tabId,
            frameId: frameId,
            videoTitle: videoInfo.filename
        }, response => {
            // Make sure we haven't been cancelled before processing response
            if (!activeCapture || activeCapture.cancelled) return;

            if (response && response.success) {
                // Wait for animation to show 100% before cleanup
                setTimeout(() => {
                    if (!activeCapture || activeCapture.cancelled) return;

                    // Reset transcript panel
                    chrome.runtime.sendMessage({
                        action: 'resetTranscriptPanel',
                        tabId: tabId,
                        frameId: frameId
                    });

                    // Wait another 2 seconds before clearing UI
                    setTimeout(() => {
                        if (!activeCapture || activeCapture.cancelled) return;

                        // Clean up
                        window.removeEventListener('message', handleIframeMessage);

                        // Only remove overlay if not part of a batch process
                        if (!activeCapture.isBatchProcess) {
                            removeOverlay(overlay);
                        }

                        if (progressState.animationId) {
                            cancelAnimationFrame(progressState.animationId);
                        }

                        // Store a backup of important info before clearing activeCapture
                        const wasBatchProcess = activeCapture.isBatchProcess;

                        // Clear active capture reference
                        activeCapture = null;

                        // Signal success to callback
                        if (callback) callback({
                            success: true,
                            fileName: response.fileName,
                            text: response.text,
                            wasBatchProcess: wasBatchProcess
                        });
                    }, 2000);
                }, 500); // Short delay to ensure animation completes
            } else {
                // If capture failed, refresh iframes if we haven't tried yet
                if (!progressState.refreshAttempted) {
                    progressState.refreshAttempted = true;
                    refreshAndRetry("Capture failed", videoInfo);
                } else {
                    handleFailure("Failed to capture transcript even after refresh");
                }
            }
        });
    }

    // Handle failure
    function handleFailure(errorMessage) {
        // Make sure we still have an active capture
        if (!activeCapture || activeCapture.cancelled) return;

        console.error('Transcript processing failed:', errorMessage);

        // Stop progress animation
        if (progressState.animationId) {
            cancelAnimationFrame(progressState.animationId);
            progressState.animationId = null;
        }

        // Update overlay with error
        updateOverlayStatus(overlay, "error", `Error: ${errorMessage}`);

        // For batch processes, we don't add buttons here - the batch handler will manage this
        if (activeCapture.isBatchProcess) {
            // Save the error message and let the batch process handle it
            if (callback) callback({
                success: false,
                error: errorMessage,
                wasBatchProcess: true
            });
            return;
        }

        // Remove the cancel button
        const cancelBtn = overlay.element.querySelector('.overlay-button.secondary');
        if (cancelBtn) {
            cancelBtn.remove();
        }

        // Add retry button with same styling as cancel button
        addOverlayButton(overlay, "Retry", () => {
            // Remove message listener before cleaning up
            window.removeEventListener('message', handleIframeMessage);
            removeOverlay(overlay);
            activeCapture = null;
            processVideoTranscript(videoInfo, callback);
        }, "secondary"); // Use secondary class for consistent styling

        // Add close button
        addOverlayButton(overlay, "Close", () => {
            // Remove message listener before cleaning up
            window.removeEventListener('message', handleIframeMessage);
            removeOverlay(overlay);
            activeCapture = null;
            if (callback) callback({success: false, error: errorMessage});
        });
    }
}

// Function to process multiple videos with sequential downloading
function processAllVideos(videoIds) {
    if (!videoIds || videoIds.length === 0) return;

    let currentIndex = 0;
    let processingOverlay = null;
    let hasEncounteredError = false;

    // Reset download tracking to handle new batch
    processedDownloads = new Set();

    // Create a processing overlay for all videos
    function createProcessingOverlay(totalVideos) {
        const overlay = document.createElement('div');
        overlay.id = 'transcript-downloader-overlay';

        const content = document.createElement('div');
        content.className = 'overlay-content';

        const title = document.createElement('div');
        title.className = 'overlay-title';
        title.textContent = `Processing Multiple Videos`;
        content.appendChild(title);

        const message = document.createElement('div');
        message.className = 'overlay-message';
        message.textContent = `Preparing to capture transcripts...`;
        content.appendChild(message);

        const progressContainer = document.createElement('div');
        progressContainer.className = 'overlay-progress-container';

        const progressBar = document.createElement('div');
        progressBar.className = 'overlay-progress-bar';
        progressContainer.appendChild(progressBar);
        content.appendChild(progressContainer);

        const status = document.createElement('div');
        status.className = 'overlay-status';
        content.appendChild(status);

        const buttonContainer = document.createElement('div');
        buttonContainer.className = 'overlay-button-container';
        content.appendChild(buttonContainer);

        overlay.appendChild(content);
        document.body.appendChild(overlay);

        // Add cancel button
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'overlay-button secondary';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', () => {
            // Cancel the active process
            cancelActiveCapture();

            // Remove this overlay
            if (overlay && overlay.parentNode) {
                overlay.parentNode.removeChild(overlay);
            }
        });
        buttonContainer.appendChild(cancelBtn);

        return {
            element: overlay,
            title: title,
            message: message,
            progressBar: progressBar,
            status: status,
            buttonContainer: buttonContainer,
            batchInfo: {currentIndex: 0, totalVideos: totalVideos},
            updateProgress: (current, total, text, percent) => {
                // Update batch info
                if (overlay.batchInfo) {
                    overlay.batchInfo.currentIndex = current;
                }

                // If a specific percentage is provided, use that
                const progressPercent = percent !== undefined
                    ? percent
                    : ((current / total) * 100);

                message.textContent = text || `Capturing transcript ${current + 1} of ${total}...`;
                progressBar.style.width = `${progressPercent}%`;

                // Always update the title to show the current progress
                title.textContent = `Processing Videos (${current + 1}/${total})`;
            }
        };
    }

    // Main process function
    function processNext() {
        if (currentIndex >= videoIds.length) {
            // All videos processed, clean up
            console.log('All videos processed successfully');
            if (processingOverlay) {
                // Update the overlay
                processingOverlay.title.textContent = `Processing Complete`;
                processingOverlay.updateProgress(
                    videoIds.length - 1,
                    videoIds.length,
                    hasEncounteredError
                        ? `Processing complete with some errors. Check downloads.`
                        : `All transcripts processed successfully!`,
                    100  // Force progress to 100%
                );

                // Change cancel button to "Close"
                const cancelBtn = processingOverlay.element.querySelector('.overlay-button.secondary');
                if (cancelBtn) {
                    cancelBtn.textContent = 'Close';
                    // Replace the event listener
                    const newCancelBtn = cancelBtn.cloneNode(true);
                    newCancelBtn.addEventListener('click', () => {
                        if (processingOverlay && processingOverlay.element && processingOverlay.element.parentNode) {
                            processingOverlay.element.parentNode.removeChild(processingOverlay.element);
                            processingOverlay = null;
                        }
                    });
                    cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);
                }
            }
            return;
        }

        const videoId = videoIds[currentIndex];
        const video = detectedVideos.find(v => v.id === videoId);

        if (video) {
            // Focus explicitly on the video we're about to process
            video.iframe.scrollIntoView({behavior: 'smooth', block: 'center'});

            // Update overlay before starting processing
            if (processingOverlay) {
                // Update the batch info to show which video we're on
                processingOverlay.batchInfo.currentIndex = currentIndex;

                // Update title to reflect current progress
                processingOverlay.title.textContent = `Processing Videos (${currentIndex + 1}/${videoIds.length})`;

                processingOverlay.updateProgress(
                    currentIndex,
                    videoIds.length,
                    `Preparing to capture video ${currentIndex + 1} of ${videoIds.length}: "${video.title}"`,
                    Math.min(99, ((currentIndex / videoIds.length) * 100))
                );
            }

            // Process this video using the batch overlay
            processVideoTranscript(video, result => {
                // Video is processed, move to the next one
                currentIndex++;

                if (processingOverlay) {
                    if (result.success) {
                        // Calculate a percent that represents the current progress
                        const percent = Math.min(99, ((currentIndex / videoIds.length) * 100));

                        // If we're not at the end, update for the next video
                        if (currentIndex < videoIds.length) {
                            const nextVideo = detectedVideos.find(v => v.id === videoIds[currentIndex]);
                            const nextTitle = nextVideo ? nextVideo.title : "next video";

                            processingOverlay.updateProgress(
                                currentIndex,
                                videoIds.length,
                                `Video ${currentIndex} complete. Processing video ${currentIndex + 1}: "${nextTitle}"`,
                                percent
                            );
                        } else {
                            processingOverlay.updateProgress(
                                currentIndex,
                                videoIds.length,
                                `All videos processed. Finishing up...`,
                                percent
                            );
                        }
                    } else {
                        hasEncounteredError = true;
                        processingOverlay.status.textContent = `Error with video "${video.title}": ${result.error}`;

                        // Still update the progress for the next video
                        const percent = Math.min(99, ((currentIndex / videoIds.length) * 100));

                        if (currentIndex < videoIds.length) {
                            const nextVideo = detectedVideos.find(v => v.id === videoIds[currentIndex]);
                            const nextTitle = nextVideo ? nextVideo.title : "next video";

                            processingOverlay.updateProgress(
                                currentIndex,
                                videoIds.length,
                                `Moving to video ${currentIndex + 1} of ${videoIds.length}: "${nextTitle}"`,
                                percent
                            );
                        }
                    }
                }

                if (currentIndex < videoIds.length) {
                    // Process next video after a short delay
                    setTimeout(processNext, 1000);
                } else {
                    // All videos processed - call processNext again to handle completion
                    processNext();
                }
            }, processingOverlay); // Pass the batch overlay
        } else {
            // Video not found, skip to next
            currentIndex++;

            if (processingOverlay) {
                processingOverlay.status.textContent = `Video ${currentIndex} not found, skipping.`;
            }

            // Continue with next video
            setTimeout(processNext, 500);
        }
    }

    // Create the processing overlay
    processingOverlay = createProcessingOverlay(videoIds.length);

    // Get the first video we'll process
    const firstVideo = detectedVideos.find(v => v.id === videoIds[0]);

    // If we need to refresh all iframes, do it before starting the process
    if (shouldRefreshAllIframes) {
        processingOverlay.updateProgress(
            0,
            videoIds.length,
            `Refreshing all video players before starting...`,
            5  // Show a little progress
        );

        // First focus on the first video we'll process
        if (firstVideo && firstVideo.iframe) {
            firstVideo.iframe.scrollIntoView({behavior: 'smooth', block: 'center'});
        }

        // Refresh all iframes but make sure we focus on the first video after refresh
        reloadAllVideoIframes(firstVideo);

        // Wait for iframes to reload before starting
        setTimeout(() => {
            // Focus on the first video again to make sure
            if (firstVideo && firstVideo.iframe) {
                firstVideo.iframe.scrollIntoView({behavior: 'smooth', block: 'center'});
            }

            processingOverlay.updateProgress(
                0,
                videoIds.length,
                `Starting first video...`,
                10  // Show a little more progress
            );

            // Start processing the first video
            setTimeout(processNext, 500);
        }, 2500);
    } else {
        // Focus on the first video
        if (firstVideo && firstVideo.iframe) {
            firstVideo.iframe.scrollIntoView({behavior: 'smooth', block: 'center'});
        }

        // Start processing the first video
        setTimeout(processNext, 500);
    }
}

// Create a modern Material Design overlay to show status messages
function createOverlay(videoTitle) {
    const overlay = document.createElement('div');
    overlay.id = 'transcript-downloader-overlay';

    const content = document.createElement('div');
    content.className = 'overlay-content';

    const title = document.createElement('div');
    title.className = 'overlay-title';
    title.textContent = `Capturing "${videoTitle}"`;
    content.appendChild(title);

    const message = document.createElement('div');
    message.className = 'overlay-message';
    message.textContent = "Preparing for transcript capture...";
    content.appendChild(message);

    const progressContainer = document.createElement('div');
    progressContainer.className = 'overlay-progress-container';

    const progressBar = document.createElement('div');
    progressBar.className = 'overlay-progress-bar';
    progressContainer.appendChild(progressBar);
    content.appendChild(progressContainer);

    const status = document.createElement('div');
    status.className = 'overlay-status';
    content.appendChild(status);

    const buttonContainer = document.createElement('div');
    buttonContainer.className = 'overlay-button-container';
    content.appendChild(buttonContainer);

    overlay.appendChild(content);
    document.body.appendChild(overlay);

    return {
        element: overlay,
        title: title,
        message: message,
        progressBar: progressBar,
        status: status,
        buttonContainer: buttonContainer
    };
}

// Update overlay progress
function updateOverlayProgress(overlay, percentage, message) {
    if (overlay.progressBar) {
        overlay.progressBar.style.width = `${percentage}%`;
    }

    if (overlay.message && message) {
        overlay.message.textContent = message;
    }
}

// Update overlay status
function updateOverlayStatus(overlay, type, message) {
    if (overlay.message && message) {
        overlay.message.textContent = message;
    }
}

// Add button to overlay
function addOverlayButton(overlay, text, onClick, className = '') {
    const button = document.createElement('button');
    button.className = `overlay-button ${className}`;
    button.textContent = text;
    button.addEventListener('click', onClick);

    overlay.buttonContainer.appendChild(button);
    return button;
}

// Remove overlay
function removeOverlay(overlay) {
    if (overlay && overlay.element && overlay.element.parentNode) {
        overlay.element.parentNode.removeChild(overlay.element);
    }
}

// Listen for browser navigation events (back/forward buttons)
window.addEventListener('pageshow', (event) => {
    // Check if the page is being restored from bfcache (back-forward cache)
    if (event.persisted) {
        console.log('Page was restored from back/forward cache, re-initializing...');
        // Scan for videos automatically when returning to a page via back button
        setTimeout(() => {
            scanForVideos();
        }, 500);
    }
});

// Listen for messages from the popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('Content script received message:', message);

    if (message.action === 'scanForVideos') {
        const videos = scanForVideos();

        // Return simplified video object (without DOM elements)
        const simplifiedVideos = videos.map(video => ({
            id: video.id,
            videoId: video.videoId,
            title: video.title,
            filename: video.filename
        }));

        sendResponse({videos: simplifiedVideos});
        return true;
    } else if (message.action === 'autoScanForVideos') {
        // Automatically scan for videos when page loads/changes
        scanForVideos();
        return true;
    } else if (message.action === 'processVideo') {
        const videoId = message.videoId;
        const video = detectedVideos.find(v => v.id === videoId);

        if (!video) {
            sendResponse({success: false, error: 'Video not found'});
            return true;
        }

        // Check if we need to refresh all iframes first
        if (shouldRefreshAllIframes) {
            // Create a temporary overlay to show we're refreshing iframes
            const tempOverlay = createOverlay("Refreshing Video Players");
            updateOverlayProgress(tempOverlay, 10, "Refreshing all video players...");

            // Focus on the video we want to process
            video.iframe.scrollIntoView({behavior: 'smooth', block: 'center'});

            // Refresh all iframes but make sure we focus on our target video
            reloadAllVideoIframes(video);

            // Wait for iframes to reload before starting
            setTimeout(() => {
                // Remove the temporary overlay
                removeOverlay(tempOverlay);

                // Focus again on the video we want to process
                video.iframe.scrollIntoView({behavior: 'smooth', block: 'center'});

                // Now process the video normally
                processVideoTranscript(video, result => {
                    sendResponse(result);
                });
            }, 2500);
        } else {
            processVideoTranscript(video, result => {
                sendResponse(result);
            });
        }

        return true;
    } else if (message.action === 'processAllVideos') {
        processAllVideos(message.videoIds);
        sendResponse({success: true});
        return true;
    } else if (message.action === 'cancelCapture') {
        cancelActiveCapture();
        sendResponse({success: true});
        return true;
    }
});