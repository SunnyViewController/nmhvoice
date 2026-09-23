// chatbot.js - Text chatbot + LiveKit voice AI

document.addEventListener('DOMContentLoaded', function () {
	const toggleBtn = document.getElementById('chatbotToggleBtn');
	const closeBtn = document.getElementById('chatbotCloseBtn');
	const chatbotWindow = document.getElementById('chatbotWindow');
	const sendBtn = document.getElementById('chatbotSendBtn');
	const chatbotInput = document.getElementById('chatbotInput');
	const chatbotMessages = document.getElementById('chatbotMessages');
	const quickBtns = document.querySelectorAll('.quick-btn');

	let conversationMemory = [];

	const aiAvatarUrl = 'AI_assistant.png';
	const userAvatarUrl = 'https://cdn-icons-png.flaticon.com/512/847/847969.png';

	const LIVEKIT_CLIENT_URL = 'https://cdn.jsdelivr.net/npm/livekit-client@2.7.0/dist/livekit-client.umd.min.js';

	// ================================================
	// Voice (LiveKit WebRTC)
	// ================================================
	const voiceBtn = document.getElementById('voiceInputBtn');
	let room = null;
	let isVoiceActive = false;
	let micStream = null;

	// ================================================
	// Unified media type detection & extraction
	// ================================================

	function detectMediaTypeFromUrl(url) {
		if (!url) return null;
		const u = String(url).toLowerCase();

		if (/vimeo\.com|youtube\.com|youtu\.be/.test(u)) return 'video';
		if (/\.(mp4|mov|webm|avi)(\?|#|$)/.test(u)) return 'video';
		if (/\.(jpg|jpeg|png|gif|webp|svg)(\?|#|$)/.test(u)) return 'image';
		if (/\.(pdf|doc|docx|xlsx|ppt|pptx)(\?|#|$)/.test(u)) return 'file';
		return null;
	}

	function extractMapUrls(text) {
		const urls = [];
		if (!text) return urls;
		const regex = /\[MAP:\s*(.*?)\]/g;
		let match;
		while ((match = regex.exec(text)) !== null) urls.push(match[1].trim());
		return urls;
	}

	// Extract all media items from text in a single pass.
	// Returns { items: [{type,url,title,dataIndex}], itemDataList: [{title,description,rating,extra}], mapAddresses: [] }
	function extractMediaItems(text) {
		const result = { items: [], itemDataList: [], mapAddresses: [] };
		if (!text) return result;

		const seenUrls = new Set();
		let dataIndex = 0;

		function pushItem(url, title) {
			const cleanUrl = String(url).split('?')[0];
			const type = detectMediaTypeFromUrl(url);
			if (!type) return;
			if (seenUrls.has(cleanUrl)) return;
			seenUrls.add(cleanUrl);

			let displayTitle = title;
			if (!displayTitle) {
				if (type === 'image') displayTitle = 'Photo';
				else if (type === 'video') displayTitle = 'Video';
				else if (type === 'file') displayTitle = 'File';
			}

			result.items.push({
				type,
				url,
				title: displayTitle,
				dataIndex: dataIndex,
			});
			dataIndex++;
		}

		// 1) Markdown links: [title](url)
		const mdLinkRegex = /\[([^\]]*?)\]\((https?:\/\/[^\s)]+)\)/g;
		let match;
		while ((match = mdLinkRegex.exec(text)) !== null) {
			const title = match[1];
			const url = match[2];
			if (!detectMediaTypeFromUrl(url)) continue;
			pushItem(url, title);
		}

		// 2) Markdown images: ![alt](url)
		const mdImgRegex = /!\[([^\]]*?)\]\((https?:\/\/[^\s)]+)\)/g;
		while ((match = mdImgRegex.exec(text)) !== null) {
			const alt = match[1];
			const url = match[2];
			if (!detectMediaTypeFromUrl(url)) continue;
			pushItem(url, alt);
		}

		// 3) Bare URLs
		const bareUrlRegex = /(https?:\/\/[^\s)]+)/g;
		while ((match = bareUrlRegex.exec(text)) !== null) {
			const url = match[1];
			const type = detectMediaTypeFromUrl(url);
			if (!type) continue;
			// Skip if already captured via markdown link/img
			const cleanUrl = url.split('?')[0];
			if (seenUrls.has(cleanUrl)) continue;
			pushItem(url, null);
		}

		// 4) ITEM_DATA blocks
		const itemDataMatches = text.match(/\[ITEM_DATA:\s*(.*?)\]/g);
		if (itemDataMatches) {
			result.itemDataList = itemDataMatches.map(m => {
				const parts = m.replace(/\[ITEM_DATA:\s*|\]/g, '').split('|').map(s => s.trim());
				return {
					title: parts[0] || '',
					description: parts[1] || '',
					rating: parts[2] || '',
					extra: parts.slice(3).join(' | '),
				};
			});

			// Attach itemDataList entries to matching items by title
			result.items.forEach((item, idx) => {
				const dataEntry = result.itemDataList[idx];
				if (dataEntry && dataEntry.title) {
					item.title = dataEntry.title || item.title;
				}
			});
		}

		// 5) Map addresses
		result.mapAddresses = extractMapUrls(text);

		return result;
	}

	// ================================================
	// LiveKit voice start/stop
	// ================================================

	voiceBtn?.addEventListener('click', async () => {
		if (!isVoiceActive) {
			try {
				showConnectingUI();

				const schoolId = "g43iWISB87NdD9Hmbe95BchTJVs1";
				const VOICE = "Aoede";
				const response = await fetch(`https://livekit-token-319080578768.us-central1.run.app?school_id=${schoolId}&voice=${VOICE}`);
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const { token, url } = await response.json();

				await import(LIVEKIT_CLIENT_URL);
				const { Room, RoomEvent, Track } = window.LivekitClient;

				room = new Room({
					adaptiveStream: true,
					dynacast: true,
				});

				room.on(RoomEvent.TrackSubscribed, (track) => {
					if (track.kind === Track.Kind.Audio) {
						console.log('AI audio track received');
						const audioElement = track.attach();
						document.body.appendChild(audioElement);
						audioElement.play().catch(err => console.log('Play error:', err));
					}
				});

				room.on(RoomEvent.DataReceived, (payload) => {
					try {
						const data = JSON.parse(new TextDecoder().decode(payload));
						if (data.type === 'media' && data.items) {
							const mediaItems = [];
							const itemDataList = [];
							let dataIndex = 0;

							data.items.forEach((item) => {
								if (item.type === 'map') {
									mediaItems.push({ type: 'map', address: item.address });
									return;
								}

								const url = item.url || '';
								// Re-detect type from URL; fall back to provided type
								const detected = detectMediaTypeFromUrl(url) || item.type || 'image';

								mediaItems.push({
									type: detected,
									url: item.url,
									title: item.title || 'Media',
									dataIndex: dataIndex,
								});

								itemDataList.push({
									title: item.title || '',
									description: item.description || '',
									rating: item.rating || '',
									extra: item.extra || '',
								});

								dataIndex++;
							});

							const mapItems = mediaItems.filter(i => i.type === 'map');
							const otherItems = mediaItems.filter(i => i.type !== 'map');

							const mapText = mapItems.length > 0
								? mapItems.map(m => `[MAP: ${m.address}]`).join('\n')
								: '';

							openMediaPanel(otherItems, mapText, itemDataList);
						}
					} catch (e) {
						console.error('Data parse error:', e);
					}
				});

				room.on(RoomEvent.Disconnected, () => {
					console.log('LiveKit disconnected');
					room = null;
					stopVoice();
				});

				await room.connect(url, token);
				console.log('LiveKit connected');

				const ui = document.getElementById('voiceConnectingUI');
				if (ui) {
					const statusText = ui.querySelector('.voice-status-text');
					if (statusText) statusText.textContent = 'Connected!';
					ui.classList.add('connected');
				}

				await room.localParticipant.setMicrophoneEnabled(true);
				console.log('Microphone enabled');

				setTimeout(() => {
					hideConnectingUI();
				}, 800);

				isVoiceActive = true;
				voiceBtn.textContent = '🔴';

			} catch (err) {
				console.error('Voice error:', err);
				hideConnectingUI();
				stopVoice();
			}
		} else {
			stopVoice();
		}
	});

	function showConnectingUI() {
		const ui = document.getElementById('voiceConnectingUI');
		if (ui) {
			ui.style.display = 'flex';
			const statusText = ui.querySelector('.voice-status-text');
			if (statusText) statusText.textContent = 'Connecting...';
			ui.classList.add('connecting');
		}
	}

	function hideConnectingUI() {
		const ui = document.getElementById('voiceConnectingUI');
		if (ui) {
			ui.style.display = 'none';
			ui.classList.remove('connecting');
		}
	}

	function cancelVoice() {
		const ui = document.getElementById('voiceConnectingUI');
		if (ui) ui.style.display = 'none';
		const btn = document.getElementById('voiceInputBtn');
		if (btn) btn.click();
	}

	function stopVoice() {
		if (room) {
			const r = room;
			room = null;
			try { r.disconnect(); } catch (e) { console.warn('Disconnect error:', e); }
		}
		if (micStream) {
			micStream.getTracks().forEach(t => t.stop());
			micStream = null;
		}
		isVoiceActive = false;
		if (voiceBtn) voiceBtn.textContent = '🎤';
	}

	// ================================================
	// Text chatbot
	// ================================================

	if (window.innerWidth <= 600) {
		chatbotWindow.classList.add('initial-position');
	}

	toggleBtn.addEventListener('click', function () {
		if (chatbotWindow.style.display === 'flex') {
			chatbotWindow.style.display = 'none';
			closeMediaPanel();
		} else {
			chatbotWindow.style.display = 'flex';
			if (window.innerWidth > 600) chatbotInput.focus();
		}
	});

	document.addEventListener('click', function (event) {
		if (window.innerWidth <= 600) {
			if (document.activeElement === chatbotInput &&
				!chatbotInput.contains(event.target) &&
				!chatbotWindow.contains(event.target) &&
				chatbotWindow.style.display === 'flex') {
				chatbotInput.blur();
			}
		}
	});

	window.addEventListener('beforeunload', () => {
		if (window.speechSynthesis) window.speechSynthesis.cancel();
		stopVoice();
	});

	closeBtn.addEventListener('click', function () {
		if (window.speechSynthesis) window.speechSynthesis.cancel();
		stopVoice();
		chatbotWindow.style.display = 'none';
		closeMediaPanel();
	});

	sendBtn.addEventListener('click', sendMessageToBackend);

	chatbotInput.addEventListener('keypress', function (e) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			if (window.speechSynthesis) window.speechSynthesis.cancel();
			sendMessageToBackend();
		}
	});

	chatbotInput.addEventListener('focus', function () {
		if (window.innerWidth <= 600) chatbotWindow.style.position = 'fixed';
	});

	window.addEventListener('resize', function () {
		if (window.innerWidth > 600) {
			chatbotWindow.style.cssText = '';
			chatbotWindow.classList.remove('initial-position');
		} else {
			if (!chatbotWindow.classList.contains('initial-position')) {
				chatbotWindow.classList.add('initial-position');
			}
		}
	});

	// ================================================
	// Utilities
	// ================================================

	function getCurrentTime() {
		return new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
	}

	function getVideoType(url) {
		if (!url) return 'mp4';
		const clean = url.split('?')[0].toLowerCase();
		if (clean.endsWith('.mp4')) return 'mp4';
		if (clean.endsWith('.mov')) return 'mov';
		if (clean.endsWith('.webm')) return 'webm';
		if (clean.endsWith('.avi')) return 'avi';
		return 'mp4';
	}

	// ================================================
	// Media panel
	// ================================================

	function openMediaPanel(mediaItems, infoText, itemDataList) {
		const panel = document.getElementById('mediaSlidePanel');
		const content = document.getElementById('mediaPanelContent');
		const panelTitle = document.getElementById('panelTitle');
		const isMobile = window.innerWidth <= 600;

		content.innerHTML = '';
		const mapAddresses = infoText ? extractMapUrls(infoText) : [];
		const hasMedia = mediaItems.length > 0;
		const hasMap = mapAddresses.length > 0;
		const hasFile = mediaItems.some(item => item.type === 'file');
		const hasImage = mediaItems.some(item => item.type === 'image');
		const hasVideo = mediaItems.some(item => item.type === 'video');

		if (hasImage && hasVideo && hasFile && hasMap) panelTitle.textContent = '📷🎬📎🗺️ Media, Files & Map';
		else if (hasImage && hasVideo && hasMap) panelTitle.textContent = '📷🎬🗺️ Media & Map';
		else if (hasFile && hasMap) panelTitle.textContent = '📎🗺️ Files & Map';
		else if (hasFile && (hasImage || hasVideo)) panelTitle.textContent = '📷🎬📎 Media & Files';
		else if (hasMedia && hasMap) panelTitle.textContent = '📷🗺️ Media & Map';
		else if (hasMap) panelTitle.textContent = '🗺️ Map';
		else if (hasFile) panelTitle.textContent = '📎 Files';
		else if (hasVideo) panelTitle.textContent = '🎬 Media Preview';
		else panelTitle.textContent = '📷 Media Preview';

		const uniqueItems = [];
		const seenUrls = new Set();
		mediaItems.forEach(item => {
			if (!seenUrls.has(item.url)) { seenUrls.add(item.url); uniqueItems.push(item); }
		});

		uniqueItems.forEach((item, index) => {
			let displayTitle = item.title;
			if (item.type !== 'file' && itemDataList && itemDataList[item.dataIndex]) {
				displayTitle = itemDataList[item.dataIndex].title || item.title;
			}
			const wrapper = document.createElement('div');
			wrapper.className = 'media-item-wrapper';
			wrapper.style.cssText = 'cursor:pointer;border-radius:12px;overflow:hidden;margin-bottom:12px;border:2px solid transparent;transition:border 0.2s;';
			wrapper.onmouseenter = () => wrapper.style.borderColor = '#4361ee';
			wrapper.onmouseleave = () => wrapper.style.borderColor = 'transparent';

			if (item.type === 'image') {
				const img = document.createElement('img');
				img.src = item.url; img.alt = displayTitle; img.loading = 'lazy';
				img.style.cssText = 'width:100%;border-radius:12px;';
				img.onclick = () => openFullscreenViewer(item.url, 'image');
				wrapper.appendChild(img);
			} else if (item.type === 'video') {
				if (item.url.includes('vimeo.com') || item.url.includes('youtube.com') || item.url.includes('youtu.be')) {
					let embedUrl = item.url;
					if (item.url.includes('youtube.com/watch?v=')) {
						embedUrl = `https://www.youtube.com/embed/${new URL(item.url).searchParams.get('v')}`;
					} else if (item.url.includes('youtu.be/')) {
						embedUrl = `https://www.youtube.com/embed/${item.url.split('youtu.be/')[1]?.split('?')[0]}`;
					}
					const iframe = document.createElement('iframe');
					iframe.src = embedUrl; iframe.width = '100%'; iframe.height = '200';
					iframe.style.cssText = 'border:0;border-radius:12px;';
					iframe.allowFullscreen = true; iframe.loading = 'lazy';
					wrapper.appendChild(iframe);
				} else {
					const video = document.createElement('video');
					video.controls = true; video.preload = 'metadata';
					video.style.cssText = 'width:100%;border-radius:12px;';
					video.onclick = () => openFullscreenViewer(item.url, 'video');
					const titleLabel = document.createElement('div');
					titleLabel.style.cssText = 'font-size:13px;color:#888;margin-top:4px;text-align:center;';
					titleLabel.textContent = displayTitle;
					const source = document.createElement('source');
					source.src = item.url; source.type = `video/${getVideoType(item.url)}`;
					video.appendChild(source);
					wrapper.appendChild(video);
					wrapper.appendChild(titleLabel);
				}
			} else if (item.type === 'file') {
				const link = document.createElement('a');
				link.href = item.url; link.target = '_blank';
				link.style.cssText = 'display:flex;align-items:center;gap:8px;padding:12px;background:#f0f4ff;border-radius:8px;text-decoration:none;color:#4361ee;font-size:14px;';
				link.innerHTML = `📎 <span>${displayTitle}</span> <span style="font-size:11px;color:#888;">(Click to open)</span>`;
				wrapper.appendChild(link);
			}
			content.appendChild(wrapper);

			if (itemDataList && itemDataList[item.dataIndex]) {
				const data = itemDataList[item.dataIndex];
				const infoDiv = document.createElement('div');
				infoDiv.className = 'media-info-section';
				infoDiv.style.cssText = 'margin-top:0;margin-bottom:16px;padding:12px;background:#f8f9fa;border-radius:10px;font-size:13px;line-height:1.5;color:#333;';
				infoDiv.innerHTML = `
					<div style="font-weight:600;font-size:14px;margin-bottom:4px;">${data.title || 'Item ' + (index + 1)}</div>
					${data.description ? `<div style="color:#666;margin-bottom:4px;">${data.description}</div>` : ''}
					${data.rating ? `<div style="color:#f59e0b;">⭐ ${data.rating}</div>` : ''}
					${data.extra ? `<div style="color:#888;font-size:12px;">${data.extra}</div>` : ''}`;
				content.appendChild(infoDiv);
			}
		});

		if (mapAddresses.length > 0) {
			mapAddresses.forEach(address => {
				const mapDiv = document.createElement('div');
				mapDiv.className = 'media-map-section';
				mapDiv.style.cssText = 'margin-bottom:16px;border-radius:12px;overflow:hidden;';
				const encodedAddress = encodeURIComponent(address);
				mapDiv.innerHTML = `
					<div style="font-weight:600;font-size:13px;margin-bottom:6px;color:#333;">📍 ${address}</div>
					<iframe width="100%" height="200" style="border:0;border-radius:8px;" loading="lazy"
						referrerpolicy="no-referrer-when-downgrade"
						src="https://www.google.com/maps/embed/v1/place?key=AIzaSyAAi1AjHzAh-Cu-5YuxSSOu8L3e2sU9oNA&q=${encodedAddress}"></iframe>
					<a href="https://www.google.com/maps/search/?api=1&query=${encodedAddress}" target="_blank"
						style="font-size:12px;color:#4361ee;text-decoration:none;display:inline-block;margin-top:4px;">🔗 Open in Google Maps</a>`;
				content.appendChild(mapDiv);
			});
		}

		const rect = chatbotWindow.getBoundingClientRect();
		if (isMobile) {
			panel.style.top = '10px'; panel.style.left = '10px'; panel.style.right = '10px'; panel.style.bottom = '20px';
			panel.style.width = 'auto'; panel.style.maxHeight = 'none'; panel.style.borderRadius = '20px'; panel.style.zIndex = '10001';
		} else {
			panel.style.top = rect.top + 'px'; panel.style.left = (rect.left - 385) + 'px'; panel.style.right = 'auto'; panel.style.bottom = 'auto';
			panel.style.width = '370px'; panel.style.maxHeight = rect.height + 'px'; panel.style.borderRadius = '16px';
		}
		panel.style.display = 'flex';
	}

	function closeMediaPanel() {
		const panel = document.getElementById('mediaSlidePanel');
		if (panel) panel.style.display = 'none';
	}

	// ================================================
	// Markdown formatting
	// ================================================

	function formatMarkdown(text) {
		if (!text) return '';
		let formatted = text;
		formatted = formatted.replace(/!\[.*?\]\(.*?\)(\n)?/g, '');
		formatted = formatted.replace(/\[(.*?)\]\((.*?\.(mp4|mov|webm|avi))\)/gi, '🎬 <em>$1</em>');
		formatted = formatted.replace(/\[(.*?)\]\((https?:\/\/player\.vimeo\.com\/[^)]+)\)/gi, '🎬 <em>$1</em>');
		formatted = formatted.replace(/\[(.*?)\]\((https?:\/\/(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/)[^)]+)\)/gi, '🎬 <em>$1</em>');
		formatted = formatted.replace(/\[(.*?)\]\((.*?\.(pdf|doc|docx|xlsx|ppt|pptx))\)/gi, '📎 <em>$1</em>');
		formatted = formatted.replace(/\[ITEM_DATA:\s*(.*?)\]/g, '');
		formatted = formatted.replace(/\[MAP:\s*(.*?)\]/g, '');
		formatted = formatted.replace(/\n{3,}/g, '\n\n');
		formatted = formatted.replace(/^\n+/, '');
		formatted = formatted.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
		formatted = formatted.replace(/\*(.*?)\*/g, '<em>$1</em>');
		formatted = formatted.replace(/^## (.*?)(\n|$)/gm, '<h3 style="margin:0 0 8px;font-size:16px;font-weight:600;">$1</h3>');
		formatted = formatted.replace(/^### (.*?)(\n|$)/gm, '<h4 style="margin:0 0 6px;font-size:14px;font-weight:600;">$1</h4>');
		formatted = formatted.replace(/^# (.*?)(\n|$)/gm, '<h2 style="margin:0 0 10px;font-size:18px;font-weight:600;">$1</h2>');
		formatted = formatted.replace(/^- (.*?)(\n|$)/gm, '<li style="margin-left:15px;margin-bottom:4px;">$1</li>');
		formatted = formatted.replace(/^(\d+)\. (.*?)(\n|$)/gm, '<li style="margin-left:15px;margin-bottom:4px;">$2</li>');
		formatted = formatted.replace(/\n\n/g, '<br><br>');
		formatted = formatted.replace(/\n/g, '<br>');
		if (formatted.includes('<li>')) formatted = '<ul style="margin:8px 0;padding-left:20px;">' + formatted + '</ul>';
		return formatted;
	}

	// ================================================
	// Add message
	// ================================================

	function addMessage(text, sender) {
		const container = document.createElement('div');
		container.className = `message-container ${sender}-container`;

		if (sender === 'bot') {
			const av = document.createElement('div');
			av.className = 'avatar-container';
			const img = document.createElement('img');
			img.src = aiAvatarUrl; img.alt = 'AI'; img.className = 'avatar-img';
			av.appendChild(img);
			container.appendChild(av);
		}

		const content = document.createElement('div');
		content.className = 'message-content-wrapper';
		const bubble = document.createElement('div');
		bubble.className = `chatbot-message ${sender}-message`;
		bubble.innerHTML = formatMarkdown(text);
		content.appendChild(bubble);

		const time = document.createElement('div');
		time.className = 'message-time';
		time.textContent = getCurrentTime();
		content.appendChild(time);

		if (sender === 'bot') {
			const extracted = extractMediaItems(text);

			if (extracted.items.length > 0 || extracted.mapAddresses.length > 0) {
				openMediaPanel(extracted.items, text, extracted.itemDataList);

				const reopenBtn = document.createElement('button');
				reopenBtn.className = 'media-preview-btn';
				reopenBtn.textContent = '📷 View Media';
				reopenBtn.style.cssText = 'background:#f0f4ff;border:1px solid #4361ee;color:#4361ee;padding:6px 12px;border-radius:8px;cursor:pointer;font-size:13px;margin-top:4px;';
				reopenBtn.onclick = () => openMediaPanel(extracted.items, text, extracted.itemDataList);
				content.appendChild(reopenBtn);
			}
		}

		container.appendChild(content);

		if (sender === 'user') {
			const ua = document.createElement('div');
			ua.className = 'avatar-container user-avatar';
			const ui = document.createElement('img');
			ui.src = userAvatarUrl; ui.alt = 'You'; ui.className = 'avatar-img';
			ua.appendChild(ui);
			container.appendChild(ua);
		}

		chatbotMessages.appendChild(container);
		conversationMemory.push({ role: sender === 'user' ? 'user' : 'assistant', content: text, timestamp: new Date().toISOString() });
		if (conversationMemory.length > 15) conversationMemory = conversationMemory.slice(-15);
		chatbotMessages.scrollTop = chatbotMessages.scrollHeight;
	}

	// ================================================
	// Send message
	// ================================================

	async function sendMessageToBackend() {
		const message = chatbotInput.value.trim();
		if (!message) return;
		addMessage(message, 'user');
		chatbotInput.value = '';

		const loadContainer = document.createElement('div');
		loadContainer.className = 'message-container bot-container';
		const loadAvatar = document.createElement('div');
		loadAvatar.className = 'avatar-container';
		const lai = document.createElement('img');
		lai.src = aiAvatarUrl; lai.alt = 'AI'; lai.className = 'avatar-img';
		loadAvatar.appendChild(lai);
		loadContainer.appendChild(loadAvatar);
		const loadContent = document.createElement('div');
		loadContent.className = 'message-content-wrapper';
		const loadDiv = document.createElement('div');
		loadDiv.className = 'chatbot-message bot-message loading-message';
		loadDiv.innerHTML = '<div class="wave-dots"><div class="wave-dot"></div><div class="wave-dot"></div><div class="wave-dot"></div></div>';
		loadContent.appendChild(loadDiv);
		loadContainer.appendChild(loadContent);
		chatbotMessages.appendChild(loadContainer);
		chatbotMessages.scrollTop = chatbotMessages.scrollHeight;

		const requestData = {
			message: message,
			school_id: "g43iWISB87NdD9Hmbe95BchTJVs1",
			user_id: "anonymous",
			history: conversationMemory.slice(-10)
		};

		try {
			const response = await fetch('https://chat-stream-gmq4inexiq-uc.a.run.app/chat_stream', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(requestData)
			});
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			loadContainer.remove();

			const respContainer = document.createElement('div');
			respContainer.className = 'message-container bot-container';
			const respAvatar = document.createElement('div');
			respAvatar.className = 'avatar-container';
			const rai = document.createElement('img');
			rai.src = aiAvatarUrl; rai.alt = 'AI'; rai.className = 'avatar-img';
			respAvatar.appendChild(rai);
			respContainer.appendChild(respAvatar);
			const respContent = document.createElement('div');
			respContent.className = 'message-content-wrapper';
			const respDiv = document.createElement('div');
			respDiv.className = 'chatbot-message bot-message';
			respContent.appendChild(respDiv);
			const respTime = document.createElement('div');
			respTime.className = 'message-time';
			respTime.textContent = getCurrentTime();
			respContent.appendChild(respTime);
			respContainer.appendChild(respContent);
			chatbotMessages.appendChild(respContainer);

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '', fullResponse = '';
			const isMobile = window.innerWidth <= 600;
			let panelOpened = isMobile;

			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					respContainer.remove();
					addMessage(fullResponse, 'bot');
					if (window.innerWidth > 600) chatbotInput.focus();
					break;
				}
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() || '';
				for (const line of lines) {
					if (!line.trim() || !line.startsWith('data: ')) continue;
					try {
						const d = JSON.parse(line.substring(6));
						if (d.type === 'chunk' && d.content) {
							fullResponse += d.content;
							respDiv.innerHTML = formatMarkdown(fullResponse);
							chatbotMessages.scrollTop = chatbotMessages.scrollHeight;

							if (!panelOpened && fullResponse.length > 100) {
								const extracted = extractMediaItems(fullResponse);
								if (extracted.items.length > 0 || extracted.mapAddresses.length > 0) {
									openMediaPanel(extracted.items, fullResponse, extracted.itemDataList);
									panelOpened = true;
								}
							}
						} else if (d.type === 'error') {
							respDiv.textContent = `Error: ${d.content}`;
							reader.cancel();
							return;
						}
					} catch (e) { }
				}
			}
		} catch (error) {
			console.error('Fetch error:', error);
			loadContainer.remove();
			addMessage('A connection error has occurred, please try again.', 'bot');
		}

		if (window.innerWidth <= 600) chatbotInput.blur();
		else chatbotInput.focus();
	}

	// ================================================
	// Welcome message
	// ================================================

	function showWelcomeMessage() {
		addMessage("Welcome to **Northfield Mount Hermon**. I'm your **NMH AI assistant**. What can I help you with today?", 'bot');
		showQuickQuestions();
	}

	function showQuickQuestions() {
		const qq = document.createElement('div');
		qq.className = 'quick-questions';
		qq.innerHTML = `
			<div class="quick-questions-title">Quick questions:</div>
			<button class="quick-btn" data-question="Can you tell me how I can get to Northfield Mount Hermon?">🚗 How to get here</button>
			<button class="quick-btn" data-question="What is the application process? What documents do I need to complete and submit, and what is the deadline?">📝 Application Process</button>
			<button class="quick-btn" data-question="What are the key school events taking place this month?">📅 School Events</button>
			<button class="quick-btn" data-question="What facilities does Northfield Mount Hermon have?">🏫 School Facilities</button>
			<button class="quick-btn" data-question="How much does it cost to attend Northfield Mount Hermon School? What is the tuition?">🏫 Tuition</button>`;
		chatbotMessages.appendChild(qq);
		qq.querySelectorAll('.quick-btn').forEach(btn => {
			btn.addEventListener('click', function () {
				chatbotInput.value = this.getAttribute('data-question');
				sendMessageToBackend();
			});
		});
		chatbotMessages.scrollTop = chatbotMessages.scrollHeight;
	}

	chatbotWindow.style.display = 'none';
	setTimeout(showWelcomeMessage, 1000);
});

// ================================================
// Global functions
// ================================================

function closeMediaPanel() {
	const panel = document.getElementById('mediaSlidePanel');
	if (panel) {
		panel.querySelectorAll('iframe').forEach(iframe => iframe.src = '');
		panel.querySelectorAll('video').forEach(video => { video.pause(); video.src = ''; });
		panel.style.display = 'none';
	}
}

function openFullscreenViewer(src, type) {
	const overlay = document.createElement('div');
	overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.9);z-index:99999;display:flex;align-items:center;justify-content:center;cursor:pointer;';
	overlay.onclick = () => overlay.remove();
	if (type === 'image') {
		const img = document.createElement('img');
		img.src = src;
		img.style.cssText = 'max-width:95vw;max-height:95vh;object-fit:contain;';
		overlay.appendChild(img);
	} else {
		const video = document.createElement('video');
		video.src = src; video.controls = true; video.autoplay = true;
		video.style.cssText = 'max-width:95vw;max-height:95vh;';
		video.onclick = (e) => e.stopPropagation();
		overlay.appendChild(video);
	}
	document.body.appendChild(overlay);
}