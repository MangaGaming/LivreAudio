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
  Clock
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

const STORAGE_KEY_POS = 'livraudio_pos';
const STORAGE_KEY_FILE = 'livraudio_filename';

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
  const refreshCacheStatus = useCallback(async () => {
    const allKeys = await keys();
    const indices = new Set<number>();
    allKeys.forEach(k => {
      if (typeof k === 'string' && k.startsWith('audio_')) {
        indices.add(parseInt(k.replace('audio_', '')));
      }
    });
    setCachedIndices(indices);
  }, []);

  useEffect(() => {
    refreshCacheStatus();
    const interval = setInterval(refreshCacheStatus, 2000);
    return () => clearInterval(interval);
  }, [refreshCacheStatus]);

  const prefetchChunk = useCallback(async (index: number) => {
    if (index >= chunks.length || index < 0) return;
    if (prefetchLockRef.current.has(index)) return;
    
    const cacheKey = `audio_${index}`;
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
  }, [chunks, selectedVoice, refreshCacheStatus]);

  const handleFileUpload = useCallback(async (acceptedFiles: File[]) => {
    const uploadedFile = acceptedFiles[0];
    if (!uploadedFile) return;

    setFile(uploadedFile);
    setFileName(uploadedFile.name);
    setIsProcessing(true);
    setChunks([]);
    
    // Clear old cache for new files
    const allKeys = await keys();
    for (const k of allKeys) await del(k);
    
    try {
      const text = await extractTextFromPdf(uploadedFile);
      const textChunks = chunkText(text);
      setChunks(textChunks);
      
      const savedFile = localStorage.getItem(STORAGE_KEY_FILE);
      if (savedFile !== uploadedFile.name) {
        setCurrentChunkIndex(0);
      }
    } catch (error) {
      console.error("Processing error:", error);
    } finally {
      setIsProcessing(false);
    }
  }, []);

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
    
    try {
      const chunk = chunks[index];
      
      if (selectedVoice.type === 'ai') {
        const cacheKey = `audio_${index}`;
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
    const cacheKey = `audio_${index}`;
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
    if (isNightMode) return;
    setIsNightMode(true);
    try {
      for (let i = 0; i < chunks.length; i++) {
        if (!cachedIndices.has(i)) {
          await prefetchChunk(i);
        }
      }
    } finally {
      setIsNightMode(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#050505] text-white font-sans selection:bg-orange-500/30">
      <nav className="border-b border-white/10 px-6 py-4 flex items-center justify-between backdrop-blur-md sticky top-0 z-50">
        <div className="flex items-center gap-2">
          <div className="p-2 bg-orange-600 rounded-lg">
            <Headphones size={20} className="text-white" />
          </div>
          <span className="font-bold text-xl tracking-tight">LivrAudio</span>
        </div>
        <div className="flex items-center gap-4">
          {file && (
            <button 
              onClick={runNightMode}
              disabled={isNightMode}
              className={cn(
                "flex items-center gap-2 px-4 py-2 rounded-full text-xs font-semibold transition-all shadow-lg",
                isNightMode ? "bg-orange-500/20 text-orange-500" : "bg-white/5 hover:bg-white/10"
              )}
            >
              {isNightMode ? <Loader2 size={14} className="animate-spin" /> : <Moon size={14} />}
              <span>{isNightMode ? "Génération continue..." : "Mode Nuit"}</span>
            </button>
          )}
          {file && (
            <button 
              onClick={() => { setFile(null); setChunks([]); stopPlayback(); setFileName(''); }}
              className="text-sm text-white/50 hover:text-white"
            >
              Nouveau livre
            </button>
          )}
        </div>
      </nav>

      <main className="max-w-5xl mx-auto p-6 md:p-12">
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
        {file && !isProcessing && (
          <motion.div
            initial={{ y: 100 }} animate={{ y: 0 }} exit={{ y: 100 }}
            className="fixed bottom-0 left-0 right-0 p-8 pointer-events-none z-[100]"
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
