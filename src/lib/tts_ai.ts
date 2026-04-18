import { GoogleGenAI, Modality } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export const AI_VOICES = [
  { id: 'Puck', name: 'Puck (Chaleureux)', lang: 'fr' },
  { id: 'Charon', name: 'Charon (Profond)', lang: 'fr' },
  { id: 'Kore', name: 'Kore (Clair)', lang: 'fr' },
  { id: 'Fenrir', name: 'Fenrir (Robuste)', lang: 'fr' },
  { id: 'Zephyr', name: 'Zephyr (Doux)', lang: 'fr' },
];

export async function generateAudio(text: string, voiceId: string): Promise<ArrayBuffer> {
  const response = await ai.models.generateContent({
    model: "gemini-3.1-flash-tts-preview",
    contents: [{ parts: [{ text: text }] }],
    config: {
      responseModalities: [Modality.AUDIO],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: voiceId },
        },
      },
    },
  });

  // Log response for debugging if needed
  console.log("Gemini TTS Response:", response);

  if (!response.candidates || response.candidates.length === 0) {
    throw new Error(`Gemini candidate empty. Finish reason: ${response.candidates?.[0]?.finishReason || 'Unknown'}`);
  }

  // Iterate through parts to find audio data
  let base64Audio: string | undefined;
  for (const part of response.candidates[0].content?.parts || []) {
    if (part.inlineData?.data && part.inlineData.mimeType?.startsWith('audio/')) {
      base64Audio = part.inlineData.data;
      break;
    }
  }

  if (!base64Audio) {
    // Fallback search in all parts if mimeType check is too strict
    for (const part of response.candidates[0].content?.parts || []) {
      if (part.inlineData?.data) {
        base64Audio = part.inlineData.data;
        break;
      }
    }
  }

  if (!base64Audio) {
    throw new Error(`No audio data returned from Gemini. Text length: ${text.length}`);
  }

  const binaryString = atob(base64Audio);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

// Global Audio Context for playback
let audioContext: AudioContext | null = null;

export function getAudioContext() {
  if (!audioContext) {
    audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
  }
  return audioContext;
}

export async function playPcmData(
  buffer: ArrayBuffer, 
  rate: number = 1, 
  onEnd?: () => void,
  onProgress?: (time: number) => void
): Promise<AudioBufferSourceNode> {
  const ctx = getAudioContext();
  
  // The Gemini TTS returns 16-bit linear PCM at 24000Hz (mono)
  // We need to convert the ArrayBuffer to a Float32Array
  const int16Array = new Int16Array(buffer);
  const float32Array = new Float32Array(int16Array.length);
  for (let i = 0; i < int16Array.length; i++) {
    float32Array[i] = int16Array[i] / 32768.0;
  }

  const audioBuffer = ctx.createBuffer(1, float32Array.length, 24000);
  audioBuffer.getChannelData(0).set(float32Array);

  const source = ctx.createBufferSource();
  source.buffer = audioBuffer;
  source.playbackRate.value = rate;
  source.connect(ctx.destination);
  
  source.onended = () => {
    if (onEnd) onEnd();
  };

  source.start(0);
  
  return source;
}
