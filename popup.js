document.addEventListener('DOMContentLoaded', async () => {
  const videosContainer = document.getElementById('videos-container');
  const downloadAllBtn = document.getElementById('download-all');
  const statusElement = document.getElementById('status');
  const emptyState = document.getElementById('empty-state');

  // Hide download all button initially
  downloadAllBtn.style.display = 'none';

  // Query the active tab
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const activeTab = tabs[0];

  // Check if we're on the Ridley College page
  if (!activeTab.url.includes('ridley.edu.au')) {
    statusElement.textContent = 'Please navigate to Ridley College Moodle.';
    emptyState.style.display = 'block';
    emptyState.querySelector('p').textContent = 'Not on Ridley College site';
    return;
  }

  // Send message to content script to scan for videos
  chrome.tabs.sendMessage(activeTab.id, { action: 'scanForVideos' }, response => {
    if (chrome.runtime.lastError) {
      statusElement.textContent = 'Content script not ready. Please refresh.';
      return;
    }

    if (!response || !response.videos || response.videos.length === 0) {
      statusElement.textContent = 'No videos found on this page.';
      emptyState.style.display = 'block';
      return;
    }

    // Display found videos
    statusElement.textContent = `Found ${response.videos.length} video${response.videos.length > 1 ? 's' : ''}`;
    response.videos.forEach(video => {
      const videoCard = document.createElement('div');
      videoCard.className = 'video-card';

      const videoTitle = document.createElement('div');
      videoTitle.className = 'video-title';
      videoTitle.textContent = video.title;
      videoTitle.title = video.title; // Add tooltip for full title

      const downloadBtn = document.createElement('button');
      downloadBtn.className = 'material-button';
      downloadBtn.innerHTML = '<i class="material-icons">download</i>Download';
      downloadBtn.dataset.videoId = video.id;

      const statusDiv = document.createElement('div');
      statusDiv.className = 'download-status';
      statusDiv.style.display = 'none';

      const progressContainer = document.createElement('div');
      progressContainer.className = 'progress-container';
      progressContainer.style.display = 'none';

      const progressBar = document.createElement('div');
      progressBar.className = 'progress-bar';
      progressContainer.appendChild(progressBar);

      downloadBtn.addEventListener('click', () => {
        downloadBtn.disabled = true;
        downloadBtn.innerHTML = '<i class="material-icons">hourglass_empty</i>Processing';
        progressContainer.style.display = 'block';

        // Simulate progress updates
        let progress = 0;
        const progressInterval = setInterval(() => {
          progress += 5;
          if (progress > 90) clearInterval(progressInterval);
          progressBar.style.width = `${progress}%`;
        }, 300);

        // Send message to content script to process this video
        chrome.tabs.sendMessage(activeTab.id, {
          action: 'processVideo',
          videoId: parseInt(video.id)
        }, response => {
          clearInterval(progressInterval);

          if (response && response.success) {
            progressBar.style.width = '100%';
            statusDiv.style.display = 'block';
            statusDiv.className = 'download-status success-text';
            statusDiv.textContent = response.fileName ?
                `Downloaded as: ${response.fileName}` :
                'Downloaded successfully!';
            downloadBtn.innerHTML = '<i class="material-icons">check_circle</i>Done';
          } else {
            progressContainer.style.display = 'none';
            statusDiv.style.display = 'block';
            statusDiv.className = 'download-status error-text';
            statusDiv.textContent = 'Error: ' + (response?.error || 'Unknown error');
            downloadBtn.disabled = false;
            downloadBtn.innerHTML = '<i class="material-icons">refresh</i>Retry';
          }
        });

        // Close the popup after clicking download
        window.close();
      });

      videoCard.appendChild(videoTitle);
      videoCard.appendChild(downloadBtn);
      videoCard.appendChild(progressContainer);
      videoCard.appendChild(statusDiv);
      videosContainer.appendChild(videoCard);
    });

    // Show download all button if multiple videos are found
    if (response.videos.length > 1) {
      downloadAllBtn.style.display = 'flex';

      downloadAllBtn.addEventListener('click', () => {
        // Close the popup when "Download All" is clicked
        window.close();

        // Send message to process all videos
        chrome.tabs.sendMessage(activeTab.id, {
          action: 'processAllVideos',
          videoIds: response.videos.map(v => v.id)
        });
      });
    }
  });
});