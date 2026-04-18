import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import { 
  FileText, 
  Play, 
  Pause, 
  SkipBack, 
  SkipForward, 
  Volume2, 
  Languages, 
  BookOpen, 
  Loader2,
  Settings2,
  Headphones,
  Download,
  Moon,
  Save,
  Clock,
  Library,
  ChevronLeft,
  ChevronRight,
  Trash2,
  Plus
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { get, set, keys, del } from 'idb-keyval';
import { extractTextFromPdf } from './lib/pdf';
import { chunkText, TextChunk } from './lib/gemini';
import { cn } from './lib/utils';
import { AI_VOICES, generateAudio, playPcmData, getAudioContext } from './lib/tts_ai';

interface VoiceOption {
  id: string;
  name: string;
  type: 'ai' | 'system';
  lang: string;
}

interface Book {
  id: string;
  name: string;
  text: string;
  lastUpdated: number;
  lastIndex: number;
}

const STORAGE_KEY_POS = 'livraudio_pos';
const STORAGE_KEY_FILE = 'livraudio_filename';
const STORAGE_KEY_BOOKS = 'livraudio_library';

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [fileName, setFileName] = useState<string>('');
  const [chunks, setChunks] = useState<TextChunk[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentChunkIndex, setCurrentChunkIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [isNightMode, setIsNightMode] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [selectedVoice, setSelectedVoice] = useState<VoiceOption | null>(null);
  const [progress, setProgress] = useState(0);
  const [cachedIndices, setCachedIndices] = useState<Set<number>>(new Set());
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [library, setLibrary] = useState<Book[]>([]);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const audioStartTimeRef = useRef<number>(0);
  const progressIntervalRef = useRef<number | null>(null);
  const prefetchLockRef = useRef<Set<number>>(new Set());

  // Initialize voices
  useEffect(() => {
    const systemVoices = window.speechSynthesis.getVoices();
    const formattedAiVoices: VoiceOption[] = AI_VOICES.map(v => ({ ...v, type: 'ai' }));
    const formattedSystemVoices: VoiceOption[] = systemVoices.map(v => ({ id: v.name, name: v.name, type: 'system', lang: v.lang }));
    
    const combined = [...formattedAiVoices, ...formattedSystemVoices];
    setVoices(combined);
    
    if (combined.length > 0 && !selectedVoice) {
      setSelectedVoice(combined[0]); 
    }
  }, [selectedVoice]);

  // Load saved position
  useEffect(() => {
    const savedPos = localStorage.getItem(STORAGE_KEY_POS);
    const savedFile = localStorage.getItem(STORAGE_KEY_FILE);
    if (savedPos && savedFile) {
      setCurrentChunkIndex(parseInt(savedPos));
      setFileName(savedFile);
    }
  }, []);

  // Save position
  useEffect(() => {
    if (fileName) {
      localStorage.setItem(STORAGE_KEY_POS, currentChunkIndex.toString());
      localStorage.setItem(STORAGE_KEY_FILE, fileName);
    }
  }, [currentChunkIndex, fileName]);

  // Refresh cache status
  const refreshCacheStatus = useCallback(async (name?: string) => {
    const targetName = name || fileName;
    if (!targetName) return;
    
    const allKeys = await keys();
    const indices = new Set<number>();
    allKeys.forEach(k => {
      const keyStr = String(k);
      const prefix = `audio_${targetName}_`;
      if (keyStr.startsWith(prefix)) {
        indices.add(parseInt(keyStr.replace(prefix, '')));
      }
    });
    setCachedIndices(indices);
  }, [fileName]);

  // Load Library
  useEffect(() => {
    const savedLibrary = localStorage.getItem(STORAGE_KEY_BOOKS);
    if (savedLibrary) {
      try {
        setLibrary(JSON.parse(savedLibrary));
      } catch(e) {}
    }
  }, []);

  // Save Library
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_BOOKS, JSON.stringify(library));
  }, [library]);

  const selectBook = useCallback((book: Book) => {
    setFileName(book.name);
    const textChunks = chunkText(book.text);
    setChunks(textChunks);
    setCurrentChunkIndex(book.lastIndex);
    setFile(null); // Mark as loaded from library
    refreshCacheStatus(book.name);
  }, [refreshCacheStatus]);

  const removeBook = useCallback((id: string) => {
    setLibrary(prev => prev.filter(b => b.id !== id));
    if (fileName && library.find(b => b.id === id)?.name === fileName) {
      setChunks([]);
      setFileName('');
    }
  }, [fileName, library]);

  const handleFileUpload = useCallback(async (acceptedFiles: File[]) => {
    const uploadedFile = acceptedFiles[0];
    if (!uploadedFile) return;

    setIsProcessing(true);
    setChunks([]);
    setErrorMsg(null);
    
    try {
      const text = await extractTextFromPdf(uploadedFile);
      const textChunks = chunkText(text);
      setChunks(textChunks);
      setFileName(uploadedFile.name);
      setCurrentChunkIndex(0);

      const newBook: Book = {
        id: Math.random().toString(36).substr(2, 9),
        name: uploadedFile.name,
        text: text,
        lastUpdated: Date.now(),
        lastIndex: 0
      };

      setLibrary(prev => {
        const filtered = prev.filter(b => b.name !== uploadedFile.name);
        return [newBook, ...filtered];
      });

      refreshCacheStatus(uploadedFile.name);
    } catch (error) {
      console.error("Processing error:", error);
      setErrorMsg("Impossible de lire ce PDF.");
    } finally {
      setIsProcessing(false);
    }
  }, [refreshCacheStatus]);

  useEffect(() => {
    refreshCacheStatus();
    const interval = setInterval(refreshCacheStatus, 2000);
    return () => clearInterval(interval);
  }, [refreshCacheStatus]);

  const prefetchChunk = useCallback(async (index: number) => {
    if (index >= chunks.length || index < 0) return;
    if (prefetchLockRef.current.has(index)) return;
    if (!selectedVoice || selectedVoice.type !== 'ai' || !fileName) return;

    const cacheKey = `audio_${fileName}_${index}`;
    const existing = await get(cacheKey);
    if (existing) return;

    prefetchLockRef.current.add(index);
    try {
      if (selectedVoice?.type === 'ai') {
        const audioData = await generateAudio(chunks[index].text, selectedVoice.id);
        await set(cacheKey, audioData);
        await refreshCacheStatus();
      }
    } catch (e) {
      console.error("Prefetch error", e);
    } finally {
      prefetchLockRef.current.delete(index);
    }
  }, [chunks, selectedVoice, refreshCacheStatus, fileName]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop: (acceptedFiles) => handleFileUpload(acceptedFiles),
    accept: { 'application/pdf': ['.pdf'] } as const,
    multiple: false
  });

  const stopPlayback = useCallback(() => {
    if (sourceRef.current) {
      try { sourceRef.current.stop(); } catch(e) {}
      sourceRef.current = null;
    }
    window.speechSynthesis.cancel();
    if (progressIntervalRef.current) {
      window.clearInterval(progressIntervalRef.current);
    }
    setIsPlaying(false);
  }, []);

  const startPlayback = useCallback(async (index: number) => {
    if (!chunks[index] || !selectedVoice) return;
    
    stopPlayback();
    setIsBuffering(true);
    setCurrentChunkIndex(index);

    // Sync library index
    setLibrary(prev => prev.map(book => 
      book.name === fileName ? { ...book, lastIndex: index, lastUpdated: Date.now() } : book
    ));
    
    try {
      const chunk = chunks[index];
      if (!chunk.text.trim()) {
        if (index < chunks.length - 1) return startPlayback(index + 1);
        throw new Error("Contenu vide détecté.");
      }
      
      if (selectedVoice.type === 'ai') {
        const cacheKey = `audio_${fileName}_${index}`;
        let audioData = await get(cacheKey);
        
        if (!audioData) {
          audioData = await generateAudio(chunk.text, selectedVoice.id);
          await set(cacheKey, audioData);
          await refreshCacheStatus();
        }

        const ctx = getAudioContext();
        if (ctx.state === 'suspended') await ctx.resume();

        sourceRef.current = await playPcmData(
          audioData, 
          speed, 
          () => {
            if (index < chunks.length - 1) {
              startPlayback(index + 1);
            } else {
              setIsPlaying(false);
              setProgress(100);
            }
          }
        );

        setIsPlaying(true);
        audioStartTimeRef.current = ctx.currentTime;
        
        const duration = sourceRef.current.buffer!.duration / speed;
        progressIntervalRef.current = window.setInterval(() => {
          const elapsed = ctx.currentTime - audioStartTimeRef.current;
          setProgress(Math.min((elapsed / duration) * 100, 100));
        }, 100);

        prefetchChunk(index + 1);

      } else {
        const allSystemVoices = window.speechSynthesis.getVoices();
        const voice = allSystemVoices.find(v => v.name === selectedVoice.id);
        
        const utterance = new SpeechSynthesisUtterance(chunk.text);
        if (voice) utterance.voice = voice;
        utterance.rate = speed;
        
        utterance.onend = () => {
          if (index < chunks.length - 1) {
            startPlayback(index + 1);
          } else {
            setIsPlaying(false);
          }
        };

        utterance.onboundary = (event) => {
          setProgress((event.charIndex / chunk.text.length) * 100);
        };

        window.speechSynthesis.speak(utterance);
        setIsPlaying(true);
      }
    } catch (error) {
      console.error("Playback error:", error);
      setErrorMsg(error instanceof Error ? error.message : "Erreur de lecture inconnue");
    } finally {
      setIsBuffering(false);
    }
  }, [chunks, selectedVoice, speed, stopPlayback, prefetchChunk, refreshCacheStatus]);

  const togglePlay = () => {
    if (isPlaying) {
      const ctx = getAudioContext();
      if (selectedVoice?.type === 'ai') {
        ctx.suspend();
      } else {
        window.speechSynthesis.pause();
      }
      setIsPlaying(false);
    } else {
      const ctx = getAudioContext();
      if (selectedVoice?.type === 'ai' && ctx.state === 'suspended') {
        ctx.resume();
        setIsPlaying(true);
      } else {
        if (window.speechSynthesis.paused) {
          window.speechSynthesis.resume();
          setIsPlaying(true);
        } else {
          startPlayback(currentChunkIndex);
        }
      }
    }
  };

  const nextChunk = () => {
    if (currentChunkIndex < chunks.length - 1) startPlayback(currentChunkIndex + 1);
  };

  const prevChunk = () => {
    if (currentChunkIndex > 0) startPlayback(currentChunkIndex - 1);
  };

  const downloadChunk = async (index: number) => {
    if (!fileName) return;
    const cacheKey = `audio_${fileName}_${index}`;
    let data = await get(cacheKey);
    if (!data) {
      if (!selectedVoice || selectedVoice.type !== 'ai') return;
      setIsBuffering(true);
      try {
        data = await generateAudio(chunks[index].text, selectedVoice.id);
        await set(cacheKey, data);
        await refreshCacheStatus();
      } finally { setIsBuffering(false); }
    }

    const sampleRate = 24000;
    const numChannels = 1;
    const bitsPerSample = 16;
    const pcmData = new Uint8Array(data);
    const wavHeader = new ArrayBuffer(44);
    const view = new DataView(wavHeader);

    const writeString = (offset: number, string: string) => {
      for (let i = 0; i < string.length; i++) view.setUint8(offset + i, string.charCodeAt(i));
    };

    writeString(0, 'RIFF');
    view.setUint32(4, 32 + pcmData.length, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numChannels * bitsPerSample / 8, true);
    view.setUint16(32, numChannels * bitsPerSample / 8, true);
    view.setUint16(34, bitsPerSample, true);
    writeString(36, 'data');
    view.setUint32(40, pcmData.length, true);

    const blob = new Blob([wavHeader, pcmData], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `LivrAudio_${fileName}_Part_${index + 1}.wav`;
    a.click();
  };

  const runNightMode = async () => {
    if (isNightMode || !fileName) return;
    setIsNightMode(true);
    try {
      for (let i = 0; i < chunks.length; i++) {
        if (!cachedIndices.has(i)) {
          const cacheKey = `audio_${fileName}_${i}`;
          const existing = await get(cacheKey);
          if (!existing && selectedVoice?.type === 'ai') {
            try {
              const data = await generateAudio(chunks[i].text, selectedVoice.id);
              await set(cacheKey, data);
              await refreshCacheStatus();
            } catch (e) {
              console.error(`Error generating chunk ${i}`, e);
            }
          }
        }
      }
    } finally {
      setIsNightMode(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#050505] text-white flex overflow-hidden selection:bg-orange-500/30">
      {/* Sidebar Library */}
      <AnimatePresence initial={false}>
        {isSidebarOpen && (
          <motion.aside
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: 320, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            className="h-screen bg-[#0a0a0a] border-r border-white/5 flex flex-col shrink-0 z-50 overflow-hidden"
          >
            <div className="p-6 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 bg-orange-500 rounded-lg flex items-center justify-center">
                  <Headphones size={18} className="text-black" />
                </div>
                <h2 className="font-bold text-lg tracking-tight">Bibliothèque</h2>
              </div>
            </div>

            <div className="px-6 pb-4">
               <div {...getRootProps()} className={cn(
                  "border-2 border-dashed border-white/10 p-4 rounded-2xl cursor-pointer hover:border-orange-500/50 transition-all flex flex-col items-center gap-2 group",
                  isDragActive && "border-orange-500 bg-orange-500/5"
               )}>
                  <input {...getInputProps()} />
                  <div className="w-10 h-10 bg-white/5 rounded-full flex items-center justify-center group-hover:scale-110 transition-transform">
                    <Plus size={20} className="text-orange-500" />
                  </div>
                  <span className="text-[10px] uppercase font-bold tracking-widest opacity-40">Ajouter un PDF</span>
               </div>
            </div>

            <div className="flex-1 overflow-y-auto px-4 py-2 space-y-2">
              {library.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-center p-8 opacity-20">
                  <FileText size={48} className="mb-4" />
                  <p className="text-xs">Aucun livre dans votre bibliothèque.</p>
                </div>
              ) : (
                library.map(book => (
                  <div 
                    key={book.id}
                    className={cn(
                      "p-4 rounded-2xl group transition-all flex items-center gap-4 cursor-pointer relative",
                      fileName === book.name ? "bg-orange-500/10 border border-orange-500/20" : "hover:bg-white/5 border border-transparent"
                    )}
                    onClick={() => selectBook(book)}
                  >
                    <div className={cn(
                      "w-10 h-14 rounded shadow-lg flex items-center justify-center overflow-hidden shrink-0",
                      fileName === book.name ? "bg-orange-500/20" : "bg-white/5"
                    )}>
                      <FileText size={20} className={cn(fileName === book.name ? "text-orange-500" : "opacity-40")} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <h4 className={cn("text-xs font-bold truncate", fileName === book.name ? "text-orange-500" : "text-white")}>{book.name.replace('.pdf', '')}</h4>
                      <p className="text-[10px] text-white/30 uppercase tracking-widest mt-1">
                        Partie {book.lastIndex + 1}
                      </p>
                    </div>
                    
                    <button 
                      onClick={(e) => { e.stopPropagation(); removeBook(book.id); }}
                      className="opacity-0 group-hover:opacity-40 hover:!opacity-100 p-2 hover:bg-red-500/10 hover:text-red-500 rounded-lg transition-all"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))
              )}
            </div>

            <div className="p-6 border-t border-white/5">
              <button 
                onClick={runNightMode}
                disabled={isNightMode || !fileName}
                className={cn(
                  "w-full flex items-center justify-center gap-2 py-4 rounded-2xl transition-all text-[11px] font-black uppercase tracking-widest shadow-lg",
                  isNightMode ? "bg-orange-500/20 text-orange-500" : "bg-white/5 hover:bg-white/10"
                )}
              >
                {isNightMode ? <Loader2 size={14} className="animate-spin" /> : <Moon size={14} />}
                <span>{isNightMode ? "Génération..." : "Mode Nuit"}</span>
              </button>
            </div>
          </motion.aside>
        )}
      </AnimatePresence>

      <main className="flex-1 relative overflow-y-auto h-screen scroll-smooth">
        <button 
          onClick={() => setIsSidebarOpen(!isSidebarOpen)}
          className={cn(
            "fixed top-1/2 -translate-y-1/2 z-[200] w-6 h-20 bg-[#0a0a0a] border-y border-r border-white/10 rounded-r-xl flex items-center justify-center hover:bg-orange-500/10 hover:border-orange-500/20 transition-all text-white/40 hover:text-orange-500",
            isSidebarOpen ? "left-[320px]" : "left-0"
          )}
        >
          {isSidebarOpen ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
        </button>

        <div className="fixed inset-0 bg-[#050505] -z-10 overflow-hidden" />
        <AnimatePresence mode="wait">
          {!file && !isProcessing ? (
            <motion.div
              key="uploader"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="flex flex-col items-center justify-center min-h-[60vh] text-center"
            >
              <div className="mb-8 max-w-2xl px-4">
                <h1 className="text-5xl md:text-7xl font-bold mb-6 leading-tight tracking-tighter">
                  Lecture <span className="text-orange-500 italic font-serif">Infinie</span>
                </h1>
                <p className="text-white/60 text-lg md:text-xl">
                  Déposez un livre. Nous nous occupons du reste. Reprise automatique garantie.
                </p>
              </div>

              <div 
                {...getRootProps()} 
                className={cn(
                  "w-full max-w-xl p-12 border-2 border-dashed rounded-[40px] transition-all cursor-pointer group",
                  isDragActive ? "border-orange-500 bg-orange-500/5" : "border-white/10 hover:border-white/20 hover:bg-white/[0.02]"
                )}
              >
                <input {...getInputProps()} />
                <div className="flex flex-col items-center gap-4">
                  <div className="w-20 h-20 bg-white/5 rounded-3xl flex items-center justify-center group-hover:scale-110 transition-transform">
                    <FileText className="text-orange-500" size={40} />
                  </div>
                  <div className="space-y-1">
                    <p className="font-medium text-xl">Sélectionnez votre PDF</p>
                    <p className="text-white/40 text-sm">Votre progression est sauvegardée en local.</p>
                  </div>
                </div>
              </div>
              
              {fileName && !file && (
                <div className="mt-12 flex flex-col items-center gap-2 text-white/30">
                  <Clock size={20} />
                  <p className="text-sm">Reprendre : <span className="text-orange-500 font-bold">{fileName}</span></p>
                  <p className="text-[10px] uppercase tracking-widest">Dernière position : Partie {currentChunkIndex + 1}</p>
                </div>
              )}
            </motion.div>
          ) : isProcessing ? (
            <motion.div
              key="loader"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col items-center justify-center min-h-[60vh] gap-8"
            >
              <div className="relative">
                <Loader2 className="animate-spin text-orange-500" size={64} />
                <div className="absolute inset-0 blur-3xl bg-orange-500/20 rounded-full" />
              </div>
              <h2 className="text-2xl font-medium tracking-tight">Analyse du livre en cours...</h2>
            </motion.div>
          ) : (
            <motion.div
              key="player"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              className="grid grid-cols-1 lg:grid-cols-[1fr_350px] gap-8 items-start"
            >
              <div className="space-y-8">
                <div className="space-y-1">
                  <div className="flex items-center gap-4 text-orange-500 text-sm font-medium uppercase tracking-[0.2em] mb-2">
                    <div className="flex items-center gap-2">
                       <BookOpen size={14} />
                       <span>Partie {currentChunkIndex + 1} / {chunks.length}</span>
                    </div>
                  </div>
                  <h2 className="text-4xl md:text-5xl font-bold tracking-tight mb-6">
                    {fileName.replace('.pdf', '')}
                  </h2>
                </div>

                {errorMsg && (
                  <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-2xl text-red-500 text-sm flex items-center justify-between">
                    <span>{errorMsg}</span>
                    <button onClick={() => setErrorMsg(null)} className="underline opacity-50 hover:opacity-100">Fermer</button>
                  </div>
                )}

                  <div className="relative p-12 bg-white/[0.02] border border-white/5 rounded-[48px] shadow-2xl min-h-[400px]">
                   <div className="absolute -left-10 top-20 opacity-5 select-none text-[200px] font-serif font-black italic">
                      {currentChunkIndex + 1}
                   </div>
                  <div className="relative z-10 prose prose-invert prose-xl max-w-none text-white/70 leading-relaxed font-serif italic text-justify max-h-[500px] overflow-y-auto custom-scrollbar">
                    {chunks[currentChunkIndex]?.text}
                  </div>
                  <div className="h-12 bg-gradient-to-t from-[#050505] to-transparent absolute bottom-0 left-0 right-0 pointer-events-none z-20" />
                </div>
              </div>

              <div className="lg:sticky lg:top-28 space-y-6">
                <div className="p-6 bg-white/[0.03] border border-white/10 rounded-[32px] space-y-6 backdrop-blur-xl">
                  <div className="space-y-4">
                    <label className="text-[10px] font-bold text-white/40 uppercase tracking-[0.2em]">Voice & Mode</label>
                    <select 
                      value={selectedVoice?.id || ''} 
                      onChange={(e) => {
                        const v = voices.find(v => v.id === e.target.value);
                        if (v) { setSelectedVoice(v); stopPlayback(); }
                      }}
                      className="w-full bg-[#0a0a0a] border border-white/10 rounded-2xl px-4 py-3 text-sm focus:ring-1 focus:ring-orange-500 appearance-none cursor-pointer"
                    >
                      <optgroup label="✨ Intelligence Artificielle">
                        {voices.filter(v => v.type === 'ai').map(voice => (
                          <option key={voice.id} value={voice.id}>{voice.name}</option>
                        ))}
                      </optgroup>
                      <optgroup label="System">
                        {voices.filter(v => v.type === 'system').map(voice => (
                          <option key={voice.id} value={voice.id}>{voice.name}</option>
                        ))}
                      </optgroup>
                    </select>
                  </div>

                  <div className="space-y-4">
                    <div className="flex justify-between items-center text-[10px] font-bold text-white/40 uppercase tracking-widest">
                       <span>Vitesse</span>
                       <span className="text-orange-500 font-mono text-xs">{speed}x</span>
                    </div>
                    <input 
                      type="range" min="0.5" max="2" step="0.1" value={speed}
                      onChange={(e) => setSpeed(parseFloat(e.target.value))}
                      className="w-full accent-orange-500 h-1 bg-white/10 rounded-full appearance-none cursor-pointer"
                    />
                  </div>

                  <button
                    onClick={() => downloadChunk(currentChunkIndex)}
                    className="w-full flex items-center justify-center gap-2 py-4 bg-white/5 hover:bg-white/10 rounded-2xl transition-all text-[11px] font-black uppercase tracking-widest"
                  >
                    <Download size={16} />
                    <span>Sauvegarder en .WAV</span>
                  </button>
                </div>

                <div className="p-6 bg-white/[0.02] border border-white/5 rounded-[32px]">
                   <p className="text-[10px] font-bold text-white/30 uppercase mb-4 tracking-widest">File d'attente</p>
                   <div className="space-y-3">
                      {[0, 1, 2].map(offset => {
                        const idx = currentChunkIndex + offset;
                        if (idx >= chunks.length) return null;
                        return (
                          <div key={idx} className="flex items-center justify-between group">
                             <div className="flex items-center gap-3">
                               <span className={cn(
                                 "text-[10px] font-mono",
                                 idx === currentChunkIndex ? "text-orange-500" : "opacity-20"
                               )}>
                                 {String(idx + 1).padStart(2, '0')}
                               </span>
                               <span className={cn(
                                 "text-xs truncate max-w-[150px]",
                                 idx === currentChunkIndex ? "font-bold" : "opacity-40"
                               )}>
                                 Partie {idx + 1}
                               </span>
                             </div>
                             {cachedIndices.has(idx) && (
                               <div className="w-1.5 h-1.5 bg-green-500 rounded-full shadow-[0_0_8px_rgba(34,197,94,0.4)]" />
                             )}
                          </div>
                        );
                      })}
                   </div>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      <AnimatePresence>
        {fileName && !isProcessing && (
          <motion.div
            initial={{ y: 100 }} animate={{ y: 0 }} exit={{ y: 100 }}
            className={cn(
              "fixed bottom-0 right-0 p-8 pointer-events-none z-[100] transition-all duration-500",
              isSidebarOpen ? "left-[320px]" : "left-0"
            )}
          >
            <div className="max-w-4xl mx-auto bg-[#111111]/90 backdrop-blur-3xl border border-white/10 p-5 rounded-[40px] shadow-2xl pointer-events-auto flex flex-col gap-5">
              <div className="w-full h-1.5 bg-white/5 rounded-full overflow-hidden">
                <motion.div 
                   className="h-full bg-orange-500 shadow-[0_0_20px_rgba(249,115,22,0.6)]" 
                   initial={{ width: 0 }} animate={{ width: `${progress}%` }}
                />
              </div>

              <div className="flex items-center justify-between gap-6">
                <div className="flex items-center gap-4 flex-1 overflow-hidden">
                   <div className="w-14 h-14 bg-white/5 rounded-2xl flex items-center justify-center text-orange-500 animate-pulse-slow">
                     <Volume2 size={28} />
                   </div>
                   <div className="overflow-hidden">
                     <h4 className="font-bold truncate text-lg leading-tight">{fileName.replace('.pdf', '')}</h4>
                     <p className="text-[10px] text-white/30 uppercase tracking-[0.2em]">Partie {currentChunkIndex + 1} de {chunks.length}</p>
                   </div>
                </div>

                <div className="flex items-center gap-4">
                  <button onClick={prevChunk} disabled={currentChunkIndex === 0} className="p-3 hover:bg-white/5 rounded-full disabled:opacity-20"><SkipBack size={28} /></button>
                  <button onClick={togglePlay} disabled={isBuffering} className="w-20 h-20 bg-orange-600 hover:bg-orange-500 rounded-[32px] flex items-center justify-center transition-all shadow-2xl shadow-orange-600/30 active:scale-95 disabled:opacity-50">
                    {isBuffering ? <Loader2 className="animate-spin" size={32} /> : isPlaying ? <Pause size={36} fill="currentColor" /> : <Play size={36} className="translate-x-1" fill="currentColor" />}
                  </button>
                  <button onClick={nextChunk} disabled={currentChunkIndex === chunks.length - 1} className="p-3 hover:bg-white/5 rounded-full disabled:opacity-20"><SkipForward size={28} /></button>
                </div>
                
                <div className="hidden lg:flex flex-1 justify-end">
                   <div className="flex items-center gap-3 text-orange-500 bg-orange-500/5 px-4 py-2 rounded-2xl border border-orange-500/10">
                     <Clock size={16} />
                     <span className="text-sm font-mono font-black">{speed}x</span>
                   </div>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <style>{`
        @keyframes pulse-slow {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.6; }
        }
        .animate-pulse-slow { animation: pulse-slow 3s infinite ease-in-out; }
      `}</style>
    </div>
  );
}
