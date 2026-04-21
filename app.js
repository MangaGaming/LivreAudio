import * as pdfjsLib from 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.min.mjs';
import { get, set } from 'https://cdn.jsdelivr.net/npm/idb-keyval@6/+esm';

// Configuration and State
let appState = {
    apiKeys: [],
    library: [],
    currentBook: null,
    currentChunks: [],
    currentIndex: 0,
    isPlaying: false,
    selectedVoice: null,
    isProcessing: false,
    isSidebarOpen: true,
    progress: 0,
    audioContext: null,
    currentSource: null,
    audioStartTime: 0,
    playbackId: 0,
    cachedIndices: new Set()
};

function loadKeys() {
    const saved = localStorage.getItem('livraudio_api_keys');
    if (saved) {
        appState.apiKeys = JSON.parse(saved);
        return true;
    }
    return false;
}

function saveKeys(keysArray) {
    appState.apiKeys = keysArray.filter(k => k.trim().length > 10);
    localStorage.setItem('livraudio_api_keys', JSON.stringify(appState.apiKeys));
}

const AI_VOICES = [
    { id: 'Puck', name: 'Puck (Chaleureux)', lang: 'fr' },
    { id: 'Charon', name: 'Charon (Profond)', lang: 'fr' },
    { id: 'Kore', name: 'Kore (Clair)', lang: 'fr' },
    { id: 'Fenrir', name: 'Fenrir (Robuste)', lang: 'fr' },
    { id: 'Zephyr', name: 'Zephyr (Doux)', lang: 'fr' },
];

async function init() {
    appState.selectedVoice = AI_VOICES[0].id;
    const hasKeys = loadKeys();
    
    lucide.createIcons();
    loadLibrary();
    setupEventListeners();
    renderLibrary();
    renderVoices();
    
    if (!hasKeys) {
        document.getElementById('setup-overlay').classList.remove('hidden');
    }

    // Check for saved state
    const savedBookId = localStorage.getItem('last_book_id');
    if (savedBookId) {
        const book = appState.library.find(b => b.id === savedBookId);
        if (book) selectBook(book);
    } else {
        showView('empty');
    }
}

// --- Library Management ---

function loadLibrary() {
    const saved = localStorage.getItem('livraudio_library_vanilla');
    if (saved) {
        try { appState.library = JSON.parse(saved); } catch(e) {}
    }
}

function saveLibrary() {
    localStorage.setItem('livraudio_library_vanilla', JSON.stringify(appState.library));
}

function renderLibrary() {
    const list = document.getElementById('library-list');
    list.innerHTML = '';
    
    if (appState.library.length === 0) {
        list.innerHTML = `
            <div class="h-40 flex flex-col items-center justify-center text-center opacity-10">
                <i data-lucide="library" class="mb-2"></i>
                <p class="text-[10px] uppercase font-black">Aucun livre</p>
            </div>
        `;
        lucide.createIcons();
        return;
    }

    appState.library.forEach(book => {
        const item = document.createElement('div');
        const isActive = appState.currentBook && appState.currentBook.id === book.id;
        item.className = `p-4 rounded-[28px] group transition-all flex items-center gap-4 cursor-pointer relative ${isActive ? 'bg-blue-600 shadow-xl shadow-blue-600/20' : 'hover:bg-white/5'}`;
        
        item.innerHTML = `
            <div class="w-10 h-14 rounded-lg shadow-lg flex items-center justify-center shrink-0 ${isActive ? 'bg-white/20' : 'bg-white/5'}">
                <i data-lucide="file-text" class="w-5 h-5 ${isActive ? 'text-white' : 'text-blue-500/40'}"></i>
            </div>
            <div class="flex-1 min-w-0">
                <h4 class="text-[11px] font-black truncate leading-tight ${isActive ? 'text-white' : 'text-slate-200'}">${book.name.replace('.pdf', '')}</h4>
                <p class="text-[8px] uppercase tracking-widest mt-1 font-black ${isActive ? 'text-white/60' : 'text-white/20'}">
                    ${book.lastIndex + 1} SÉQUENCES
                </p>
            </div>
            <button class="delete-btn opacity-0 group-hover:opacity-40 hover:!opacity-100 p-2 rounded-xl transition-all ${isActive ? 'text-white' : 'hover:text-red-500'}">
                <i data-lucide="trash-2" class="w-4 h-4"></i>
            </button>
        `;
        
        item.onclick = (e) => {
            if (e.target.closest('.delete-btn')) {
                removeBook(book.id);
            } else {
                selectBook(book);
            }
        };
        
        list.appendChild(item);
    });
    lucide.createIcons();
}

function removeBook(id) {
    appState.library = appState.library.filter(b => b.id !== id);
    saveLibrary();
    if (appState.currentBook && appState.currentBook.id === id) {
        appState.currentBook = null;
        showView('empty');
    }
    renderLibrary();
}

async function selectBook(book) {
    appState.currentBook = book;
    appState.currentChunks = chunkText(book.text);
    appState.currentIndex = book.lastIndex || 0;
    localStorage.setItem('last_book_id', book.id);
    
    renderLibrary();
    showView('player');
    updatePlayerUI();
    renderChunks();
}

// --- App UI Logic ---

function showView(viewName) {
    const views = ['empty', 'loading', 'player'];
    views.forEach(v => {
        document.getElementById(`${v}-state`)?.classList.add('hidden');
        document.getElementById(`${v}-view`)?.classList.add('hidden');
    });
    
    if (viewName === 'player') {
        document.getElementById('player-view').classList.remove('hidden');
        document.getElementById('player-bar').classList.remove('hidden');
    } else {
        document.getElementById(`${viewName}-state`).classList.remove('hidden');
        document.getElementById('player-bar').classList.add('hidden');
    }
    
    appState.isProcessing = (viewName === 'loading');
}

function updatePlayerUI() {
    if (!appState.currentBook) return;
    
    document.getElementById('book-title').textContent = appState.currentBook.name.replace('.pdf', '');
    document.getElementById('bar-title').textContent = appState.currentBook.name.replace('.pdf', '');
    document.getElementById('current-part-num').textContent = `#${appState.currentIndex + 1}`;
    document.getElementById('bar-subtitle').textContent = `PARTIE ${appState.currentIndex + 1} / ${appState.currentChunks.length}`;
    document.getElementById('chunk-text').textContent = appState.currentChunks[appState.currentIndex]?.text || "...";
    
    const progress = (appState.currentIndex / (appState.currentChunks.length || 1)) * 100;
    // We update this via progress bar interval during play
}

function renderVoices() {
    const select = document.getElementById('voice-select');
    AI_VOICES.forEach(v => {
        const opt = document.createElement('option');
        opt.value = v.id;
        opt.textContent = v.name;
        select.appendChild(opt);
    });
    select.onchange = (e) => {
        appState.selectedVoice = e.target.value;
        stopPlayback();
    };
}

function renderChunks() {
    const list = document.getElementById('chunks-list');
    list.innerHTML = '';
    
    appState.currentChunks.forEach((chunk, idx) => {
        const item = document.createElement('button');
        const isActive = idx === appState.currentIndex;
        item.className = `w-full p-5 rounded-[24px] flex items-center justify-between transition-all group ${isActive ? 'bg-blue-600 text-white shadow-xl shadow-blue-600/30' : 'hover:bg-white/5'}`;
        
        item.innerHTML = `
            <div class="flex items-center gap-5">
                <span class="text-[10px] font-mono ${isActive ? 'text-white/60' : 'text-white/10'}">${String(idx + 1).padStart(2, '0')}</span>
                <span class="text-sm font-black tracking-tight ${isActive ? 'text-white' : 'text-white/30 group-hover:text-white/60'}">Partie ${idx + 1}</span>
            </div>
        `;
        
        item.onclick = () => startPlayback(idx);
        list.appendChild(item);
    });
}

// --- Text Processing ---

function chunkText(text, chunkSize = 600) {
    const chunks = [];
    let currentPos = 0;
    while (currentPos < text.length) {
        let endPos = Math.min(currentPos + chunkSize, text.length);
        if (endPos < text.length) {
            const lastEnd = text.lastIndexOf('.', endPos);
            if (lastEnd > currentPos + (chunkSize * 0.5)) endPos = lastEnd + 1;
        }
        chunks.push({ index: chunks.length, text: text.substring(currentPos, endPos).trim() });
        currentPos = endPos;
    }
    return chunks;
}

// --- PDF Extraction (Vanilla) ---

pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.worker.min.mjs';

async function extractPdf(file) {
    const arrayBuffer = await file.arrayBuffer();
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    const pdf = await loadingTask.promise;
    let fullText = '';
    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        fullText += textContent.items.map(item => item.str).join(' ') + '\n';
    }
    return fullText.trim();
}

// --- TTS & Audio Logic ---

async function generateGeminiAudio(text, voiceId) {
    if (appState.apiKeys.length === 0) {
        document.getElementById('setup-overlay').classList.remove('hidden');
        throw new Error("Veuillez configurer vos clés API Gemini.");
    }

    const keys = appState.apiKeys;
    const models = ["gemini-3.1-flash-tts-preview", "gemini-3-flash-preview", "gemini-flash-latest"];
    let lastErr = null;

    for (const apiKey of keys) {
        for (const model of models) {
            try {
                console.log(`[TTS] Synthesis attempt with key ${apiKey.substring(0, 4)}...`);
                const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey.trim()}`;
                const response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text }] }],
                        generationConfig: {
                            responseModalities: ["AUDIO"],
                            speechConfig: {
                                voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceId } }
                            }
                        }
                    })
                });

                if (!response.ok) {
                    const error = await response.json();
                    const status = error.error?.status;
                    if (status === 'RESOURCE_EXHAUSTED' || response.status === 429 || status === 'INVALID_ARGUMENT') {
                        console.warn(`[TTS] Key ${apiKey.substring(0, 4)} failed: ${status}`);
                        break; // Try next key
                    }
                    throw new Error(error.error?.message || "Erreur Gemini");
                }

                const data = await response.json();
                const base64 = data.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
                if (!base64) continue;

                const binary = atob(base64);
                const bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                return bytes.buffer;
            } catch (e) {
                lastErr = e;
            }
        }
    }
    throw lastErr || new Error("Épuisement ou invalidité de toutes les clés Gemini.");
}

async function getAudio(text, voiceId, bookId, index) {
    const cacheKey = `audio_${bookId}_${index}`;
    let data = await get(cacheKey);
    if (data) return data;

    data = await generateGeminiAudio(text, voiceId);
    await set(cacheKey, data);
    return data;
}

function getCtx() {
    if (!appState.audioContext) {
        appState.audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
    }
    return appState.audioContext;
}

async function startPlayback(index) {
    if (!appState.currentChunks[index]) return;
    
    appState.playbackId++;
    const pid = appState.playbackId;
    stopPlayback();
    
    appState.currentIndex = index;
    appState.currentBook.lastIndex = index;
    saveLibrary();
    updatePlayerUI();
    renderChunks();
    
    setLoading(true);
    
    try {
        const text = appState.currentChunks[index].text;
        const data = await getAudio(text, appState.selectedVoice, appState.currentBook.id, index);
        
        if (pid !== appState.playbackId) return;

        const ctx = getCtx();
        if (ctx.state === 'suspended') await ctx.resume();

        // Gemini audio is 16-bit linear PCM mono 24kHz
        const int16 = new Int16Array(data);
        const float32 = new Float32Array(int16.length);
        for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;

        const buffer = ctx.createBuffer(1, float32.length, 24000);
        buffer.getChannelData(0).set(float32);

        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        
        source.onended = () => {
            if (pid === appState.playbackId) {
                if (index < appState.currentChunks.length - 1) {
                    startPlayback(index + 1);
                } else {
                    appState.isPlaying = false;
                    updateControlIcons();
                }
            }
        };

        appState.currentSource = source;
        appState.audioStartTime = ctx.currentTime;
        appState.isPlaying = true;
        source.start(0);
        updateControlIcons();
        startProgressInterval(buffer.duration);
    } catch (e) {
        console.error(e);
        alert(e.message);
    } finally {
        setLoading(false);
    }
}

function stopPlayback() {
    if (appState.currentSource) {
        try { appState.currentSource.stop(); } catch(e) {}
        appState.currentSource = null;
    }
    appState.isPlaying = false;
    updateControlIcons();
}

function togglePlay() {
    if (appState.isPlaying) {
        stopPlayback();
    } else {
        startPlayback(appState.currentIndex);
    }
}

function startProgressInterval(duration) {
    const bar = document.getElementById('progress-bar');
    const update = () => {
        if (!appState.isPlaying || !appState.currentSource) return;
        const elapsed = getCtx().currentTime - appState.audioStartTime;
        const pct = Math.min((elapsed / duration) * 100, 100);
        bar.style.width = `${pct}%`;
        if (pct < 100) requestAnimationFrame(update);
    };
    requestAnimationFrame(update);
}

// --- UI Helpers ---

function setLoading(isLoading) {
    const playIcon = document.getElementById('play-icon');
    if (isLoading) {
        playIcon.setAttribute('data-lucide', 'loader-2');
        playIcon.classList.add('animate-spin');
    } else {
        playIcon.classList.remove('animate-spin');
        updateControlIcons();
    }
    lucide.createIcons();
}

function updateControlIcons() {
    const playIcon = document.getElementById('play-icon');
    playIcon.setAttribute('data-lucide', appState.isPlaying ? 'pause' : 'play');
    lucide.createIcons();
}

function setupEventListeners() {
    document.getElementById('cta-btn').onclick = () => document.getElementById('file-input').click();
    document.getElementById('dropzone').onclick = () => document.getElementById('file-input').click();
    
    // Key Setup logic
    document.getElementById('save-keys-btn').onclick = () => {
        const input = document.getElementById('keys-input').value;
        const keysArray = input.split('\n').map(k => k.trim()).filter(k => k.length > 5);
        if (keysArray.length === 0) {
            alert("Veuillez entrer au moins une clé API valide.");
            return;
        }
        saveKeys(keysArray);
        document.getElementById('setup-overlay').classList.add('hidden');
    };

    document.getElementById('settings-btn').onclick = () => {
        document.getElementById('keys-input').value = appState.apiKeys.join('\n');
        document.getElementById('setup-overlay').classList.remove('hidden');
    };

    document.getElementById('file-input').onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        
        showView('loading');
        try {
            const text = await extractPdf(file);
            const book = {
                id: Math.random().toString(36).substr(2, 9),
                name: file.name,
                text: text,
                lastIndex: 0
            };
            appState.library.unshift(book);
            saveLibrary();
            selectBook(book);
        } catch (err) {
            alert("Erreur lors de l'import : " + err.message);
            showView('empty');
        }
    };

    document.getElementById('play-btn').onclick = togglePlay;
    document.getElementById('prev-btn').onclick = () => { if (appState.currentIndex > 0) startPlayback(appState.currentIndex - 1); };
    document.getElementById('next-btn').onclick = () => { if (appState.currentIndex < appState.currentChunks.length - 1) startPlayback(appState.currentIndex + 1); };
}

// --- Sidebar Toggle ---

const sidebar = document.getElementById('sidebar');
const toggleBtn = document.getElementById('toggle-sidebar');
const mainContent = document.getElementById('main-content');
const playerBar = document.getElementById('player-bar');

toggleBtn.onclick = () => {
    appState.isSidebarOpen = !appState.isSidebarOpen;
    if (appState.isSidebarOpen) {
        sidebar.style.transform = 'translateX(0)';
        mainContent.style.marginLeft = '320px';
        playerBar.style.left = '320px';
        toggleBtn.style.left = '320px';
        document.getElementById('toggle-icon').setAttribute('data-lucide', 'chevron-left');
    } else {
        sidebar.style.transform = 'translateX(-320px)';
        mainContent.style.marginLeft = '0';
        playerBar.style.left = '0';
        toggleBtn.style.left = '0';
        document.getElementById('toggle-icon').setAttribute('data-lucide', 'chevron-right');
    }
    lucide.createIcons();
};

init();
