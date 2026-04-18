import { GoogleGenAI, Type } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export interface TextChunk {
  index: number;
  text: string;
}

/**
 * Splits a long text into chunks of roughly 30 seconds of speech.
 * 150 words/min * 6 chars/word * 0.5 mins = ~450 chars.
 * Using 600 chars for a good balance between small segments and sentence coherence.
 */
export function chunkText(text: string, chunkSize: number = 600): TextChunk[] {
  const chunks: TextChunk[] = [];
  let currentPos = 0;

  while (currentPos < text.length) {
    let endPos = Math.min(currentPos + chunkSize, text.length);
    
    // Try to find a natural break (end of sentence)
    if (endPos < text.length) {
      const lastSentenceEnd = text.lastIndexOf('.', endPos);
      if (lastSentenceEnd > currentPos + (chunkSize * 0.5)) {
        endPos = lastSentenceEnd + 1;
      }
    }

    chunks.push({
      index: chunks.length,
      text: text.substring(currentPos, endPos).trim()
    });
    currentPos = endPos;
  }

  return chunks;
}
