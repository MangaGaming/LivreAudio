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
    cachedIndices: new Set(),
    nativeVoices: [],
    localTts: null
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
    { id: 'kokoro:ff_siwis', name: 'Kokoro - Amélie (Local/FR 🇫🇷)', type: 'local' },
    { id: 'kokoro:af_heart', name: 'Kokoro - Heart (Local/EN 🇺🇸)', type: 'local' },
    { id: 'Puck', name: 'Gemini - Puck (Cloud/FR)', type: 'cloud' },
    { id: 'Charon', name: 'Gemini - Charon (Cloud/FR)', type: 'cloud' },
    { id: 'Kore', name: 'Gemini - Kore (Cloud/FR)', type: 'cloud' },
    { id: 'Fenrir', name: 'Gemini - Fenrir (Cloud/FR)', type: 'cloud' },
    { id: 'Zephyr', name: 'Gemini - Zephyr (Cloud/FR)', type: 'cloud' },
];

async function init() {
    appState.selectedVoice = AI_VOICES[0].id;
    const hasKeys = loadKeys();
    
    lucide.createIcons();
    loadLibrary();
    setupEventListeners();
    renderLibrary();
    
    // Initialize voices
    if ('speechSynthesis' in window) {
        const loadNativeVoices = () => {
            const voices = window.speechSynthesis.getVoices();
            appState.nativeVoices = voices.filter(v => v.lang.startsWith('fr'));
            renderVoices();
        };
        loadNativeVoices();
        if (window.speechSynthesis.onvoiceschanged !== undefined) {
            window.speechSynthesis.onvoiceschanged = loadNativeVoices;
        }
    } else {
        renderVoices();
    }
    
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
            <div class="h-40 flex flex-col items-center justify-center text-center opacity-5 animate-fade-in">
                <i data-lucide="library" class="mb-4 w-12 h-12"></i>
                <p class="text-[10px] uppercase font-black tracking-widest">Vide</p>
            </div>
        `;
        lucide.createIcons();
        return;
    }

    appState.library.forEach((book, idx) => {
        const item = document.createElement('div');
        const isActive = appState.currentBook && appState.currentBook.id === book.id;
        item.style.animationDelay = `${idx * 0.1}s`;
        item.className = `p-5 rounded-[32px] group transition-all flex items-center gap-5 cursor-pointer relative animate-slide-up ${isActive ? 'bg-indigo-600 shadow-2xl shadow-indigo-600/30' : 'hover:bg-white/5'}`;
        
        item.innerHTML = `
            <div class="w-12 h-16 rounded-2xl shadow-2xl flex items-center justify-center shrink-0 ${isActive ? 'bg-white/20' : 'bg-indigo-600/10'}">
                <i data-lucide="file-text" class="w-6 h-6 ${isActive ? 'text-white' : 'text-indigo-400'}"></i>
            </div>
            <div class="flex-1 min-w-0">
                <h4 class="text-xs font-black truncate leading-tight ${isActive ? 'text-white' : 'text-slate-200'}">${book.name.replace('.pdf', '')}</h4>
                <p class="text-[9px] uppercase tracking-[0.3em] mt-2 font-black ${isActive ? 'text-white/60' : 'text-white/10'}">
                    ${book.lastIndex + 1} SÉQUENCES
                </p>
            </div>
            <button class="delete-btn opacity-0 group-hover:opacity-40 hover:!opacity-100 p-3 rounded-2xl transition-all ${isActive ? 'text-white' : 'hover:text-red-500'}">
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
        const state = document.getElementById(`${v}-state`);
        const view = document.getElementById(`${v}-view`);
        if (state) state.classList.add('hidden');
        if (view) view.classList.add('hidden');
    });
    
    if (viewName === 'player') {
        const playerView = document.getElementById('player-view');
        playerView.classList.remove('hidden');
        playerView.classList.add('animate-fade-in');
        document.getElementById('player-bar').classList.remove('hidden');
    } else {
        const viewState = document.getElementById(`${viewName}-state`);
        viewState.classList.remove('hidden');
        viewState.classList.add('animate-fade-in');
        document.getElementById('player-bar').classList.add('hidden');
    }
    
    appState.isProcessing = (viewName === 'loading');
}

function updatePlayerUI() {
    if (!appState.currentBook) return;
    
    document.getElementById('book-title').textContent = appState.currentBook.name.replace('.pdf', '');
    document.getElementById('bar-title').textContent = appState.currentBook.name.replace('.pdf', '');
    document.getElementById('current-part-num').textContent = `#${appState.currentIndex + 1}`;
    document.getElementById('bar-subtitle').textContent = `PARTIE ${appState.currentIndex + 1}`;
    document.getElementById('chunk-text').textContent = appState.currentChunks[appState.currentIndex]?.text || "...";
}

function renderVoices() {
    const select = document.getElementById('voice-select');
    select.innerHTML = ''; // Clear previous

    // Cloud Voices
    AI_VOICES.forEach(v => {
        const opt = document.createElement('option');
        opt.value = v.id;
        opt.textContent = v.name;
        select.appendChild(opt);
    });

    // Native Voices
    if (appState.nativeVoices.length > 0) {
        const group = document.createElement('optgroup');
        group.label = "VOIX SYSTÈME (BASIQUE)";
        appState.nativeVoices.forEach((v, i) => {
            const opt = document.createElement('option');
            opt.value = `native:${v.name}`;
            opt.textContent = `${v.name} (Système)`;
            group.appendChild(opt);
        });
        select.appendChild(group);
    }

    select.onchange = (e) => {
        appState.selectedVoice = e.target.value;
        stopPlayback();
    };
    
    // Restore selection
    if (appState.selectedVoice) select.value = appState.selectedVoice;
}

function renderChunks() {
    const list = document.getElementById('chunks-list');
    list.innerHTML = '';
    
    appState.currentChunks.forEach((chunk, idx) => {
        const item = document.createElement('button');
        const isActive = idx === appState.currentIndex;
        item.style.animationDelay = `${idx * 0.05}s`;
        item.className = `w-full p-6 rounded-[32px] flex items-center justify-between transition-all group animate-slide-up ${isActive ? 'bg-indigo-600/20 text-white border border-indigo-500/30' : 'hover:bg-white/5'}`;
        
        item.innerHTML = `
            <div class="flex items-center gap-6">
                <span class="text-[10px] font-mono ${isActive ? 'text-indigo-400' : 'text-white/10'}">${String(idx + 1).padStart(2, '0')}</span>
                <span class="text-sm font-black tracking-tight ${isActive ? 'text-white' : 'text-white/20 group-hover:text-white/60'}">Séquence ${idx + 1}</span>
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

async function generateLocalAudio(text, voiceId) {
    if (!appState.localTts) {
        setLoading(true, "Initialisation Neural Engine Local (80MB)...");
        try {
            console.log("[Kokoro] Loading neural engine via esm.sh...");
            // esm.sh is more reliable for automatic ESM conversion
            const moduleUrl = "https://esm.sh/kokoro-js@0.1.3";
            const mod = await import(moduleUrl);
            
            // Handle different export patterns if necessary
            const KokoroTTS = mod.KokoroTTS || mod.default?.KokoroTTS || mod.default;
            
            if (!KokoroTTS) {
                throw new Error("Impossible de trouver la classe KokoroTTS dans le module importé.");
            }
            
            appState.localTts = await KokoroTTS.from_pretrained("hexgrad/Kokoro-82M");
            console.log("[Kokoro] Neural engine loaded successfully.");
        } catch (e) {
            console.error("[Kokoro] Failed to load model:", e);
            throw new Error(`Erreur Moteur Neural: ${e.message}. Veuillez vérifier votre connexion ou utiliser une voix Cloud.`);
        } finally {
            setLoading(false);
        }
    }

    const ttsVoice = voiceId.split(':')[1];
    const audio = await appState.localTts.generate(text, {
        voice: ttsVoice,
    });
    
    const float32 = audio.audio;
    const int16 = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
        int16[i] = Math.max(-1, Math.min(1, float32[i])) * 32767;
    }
    return int16.buffer;
}

async function getAudio(text, voiceId, bookId, index) {
    const cacheKey = `audio_${bookId}_${index}_${voiceId}`;
    let data = await get(cacheKey);
    if (data) return data;

    if (voiceId.startsWith('kokoro:')) {
        data = await generateLocalAudio(text, voiceId);
    } else {
        data = await generateGeminiAudio(text, voiceId);
    }
    
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
    
    const text = appState.currentChunks[index].text;
    const isNative = appState.selectedVoice.startsWith('native:');

    if (isNative) {
        appState.isPlaying = true;
        updateControlIcons();
        
        const utterance = new SpeechSynthesisUtterance(text);
        const voiceName = appState.selectedVoice.split(':')[1];
        utterance.voice = appState.nativeVoices.find(v => v.name === voiceName);
        utterance.lang = 'fr-FR';
        
        utterance.onend = () => {
            if (pid === appState.playbackId) {
                if (index < appState.currentChunks.length - 1) {
                    startPlayback(index + 1);
                } else {
                    appState.isPlaying = false;
                    updateControlIcons();
                }
            }
        };
        
        utterance.onerror = () => {
            appState.isPlaying = false;
            updateControlIcons();
        };

        window.speechSynthesis.speak(utterance);
        
        // Progress bar simulation for native (rough)
        const estDuration = text.length * 60; // Rough 60ms per char
        appState.audioStartTime = Date.now();
        startProgressIntervalNative(estDuration, pid);
    } else {
        setLoading(true);
        try {
            const data = await getAudio(text, appState.selectedVoice, appState.currentBook.id, index);
            if (pid !== appState.playbackId) return;

            const ctx = getCtx();
            if (ctx.state === 'suspended') await ctx.resume();

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
}

function stopPlayback() {
    if (window.speechSynthesis) window.speechSynthesis.cancel();
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

function startProgressIntervalNative(durationMs, pid) {
    const bar = document.getElementById('progress-bar');
    const update = () => {
        if (!appState.isPlaying || pid !== appState.playbackId) return;
        const elapsed = Date.now() - appState.audioStartTime;
        const pct = Math.min((elapsed / durationMs) * 100, 100);
        bar.style.width = `${pct}%`;
        if (pct < 100) requestAnimationFrame(update);
    };
    requestAnimationFrame(update);
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

function setLoading(isLoading, text = null) {
    const playIcon = document.getElementById('play-icon');
    const subtitle = document.querySelector('#loading-state p');
    if (text && subtitle) subtitle.textContent = text;
    
    if (isLoading) {
        playIcon?.setAttribute('data-lucide', 'loader-2');
        playIcon?.classList.add('animate-spin');
    } else {
        playIcon?.classList.remove('animate-spin');
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
