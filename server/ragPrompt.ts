export interface RetrievedChunkRef {
  rank: number;
  chunk_id: string;
  document_id: string;
  filename: string;
  page_number: number;
  text: string;
  distance: number;
  similarity: number;
}

export const DEFAULT_RAG_TOP_K = 3;
export const RAG_MAX_CHUNK_CHARS = 1_100;
export const RAG_MAX_CONTEXT_CHARS = 3_600;
export const RAG_MAX_OUTPUT_TOKENS = 512;

export const RAG_COMPACT_MAX_CHUNKS = 2;
export const RAG_COMPACT_MAX_CHUNK_CHARS = 850;
export const RAG_COMPACT_MAX_CONTEXT_CHARS = 1_800;
export const RAG_COMPACT_MAX_OUTPUT_TOKENS = 384;

export const COMPARE_MAX_TOP_K = 3;
export const COMPARE_RAG_MAX_CHUNKS = 3;
export const COMPARE_RAG_MAX_CHUNK_CHARS = 700;
export const COMPARE_RAG_MAX_CONTEXT_CHARS = 2_000;
export const COMPARE_RAG_MAX_OUTPUT_TOKENS = 448;
export const COMPARE_NO_RAG_MAX_OUTPUT_TOKENS = 448;
export const COMPARE_COMPACT_MAX_CHUNKS = 2;
export const COMPARE_COMPACT_MAX_CHUNK_CHARS = 600;
export const COMPARE_COMPACT_MAX_CONTEXT_CHARS = 1_300;
export const COMPARE_COMPACT_MAX_OUTPUT_TOKENS = 320;

export interface RagPromptOptions {
  maxChunks?: number;
  maxChunkChars?: number;
  maxContextChars?: number;
}

export interface OptimizedPassage {
  chunk: RetrievedChunkRef;
  promptText: string;
}

export interface OptimizedPromptResult {
  promptPreview: string;
  passages: OptimizedPassage[];
  originalChunksCount: number;
  deduplicatedChunksCount: number;
  contextChars: number;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function trimSentenceBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 3) return text.slice(0, Math.max(0, maxChars));
  const limit = maxChars - 3;
  const slice = text.slice(0, limit);
  const lastSpace = slice.lastIndexOf(" ");
  const cutoff = lastSpace > Math.floor(limit * 0.7) ? lastSpace : limit;
  return `${slice.slice(0, cutoff).trimEnd()}...`;
}

/**
 * Removes overlapping tail/head words when consecutive chunks from the same
 * document & page share a sliding-window overlap (e.g., 100-word chunk overlap).
 */
function stripSamePageOverlap(
  candidateWords: string[],
  existingPageWordLists: string[][]
): string[] {
  const MIN_OVERLAP_WORDS = 12;
  let words = candidateWords;

  for (const prevWords of existingPageWordLists) {
    if (words.length < MIN_OVERLAP_WORDS || prevWords.length < MIN_OVERLAP_WORDS) {
      continue;
    }

    const maxCheck = Math.min(prevWords.length, words.length, 160);

    // Case 1: previous chunk tail overlaps candidate chunk head
    for (let overlap = maxCheck; overlap >= MIN_OVERLAP_WORDS; overlap--) {
      let matches = true;
      const prevStart = prevWords.length - overlap;
      for (let i = 0; i < overlap; i++) {
        if (prevWords[prevStart + i].toLowerCase() !== words[i].toLowerCase()) {
          matches = false;
          break;
        }
      }
      if (matches) {
        words = words.slice(overlap);
        break;
      }
    }

    if (words.length < 4) {
      return [];
    }

    // Case 2: candidate chunk tail overlaps previous chunk head
    const maxCheckTail = Math.min(prevWords.length, words.length, 160);
    for (let overlap = maxCheckTail; overlap >= MIN_OVERLAP_WORDS; overlap--) {
      let matches = true;
      const candStart = words.length - overlap;
      for (let i = 0; i < overlap; i++) {
        if (words[candStart + i].toLowerCase() !== prevWords[i].toLowerCase()) {
          matches = false;
          break;
        }
      }
      if (matches) {
        words = words.slice(0, candStart);
        break;
      }
    }
  }

  return words;
}

function buildShingles(words: string[], size = 5): Set<string> {
  const set = new Set<string>();
  if (words.length < size) return set;
  for (let i = 0; i <= words.length - size; i++) {
    set.add(
      words
        .slice(i, i + size)
        .map((w) => w.toLowerCase())
        .join(" ")
    );
  }
  return set;
}

function hasHighShingleOverlap(candidateShingles: Set<string>, keptShinglesList: Set<string>[]): boolean {
  if (candidateShingles.size === 0) return false;
  for (const kept of keptShinglesList) {
    if (kept.size === 0) continue;
    let shared = 0;
    for (const s of candidateShingles) {
      if (kept.has(s)) shared += 1;
    }
    if (shared / candidateShingles.size >= 0.75) {
      return true;
    }
  }
  return false;
}

export function optimizeChunksForPrompt(
  chunks: RetrievedChunkRef[],
  options: RagPromptOptions = {}
): OptimizedPassage[] {
  const maxChunkChars = options.maxChunkChars ?? RAG_MAX_CHUNK_CHARS;
  const maxChunks = options.maxChunks ?? chunks.length;
  const selected: OptimizedPassage[] = [];
  const keptNormalized: string[] = [];
  const keptShingles: Set<string>[] = [];
  const pageWordsMap = new Map<string, string[][]>();

  for (const chunk of chunks) {
    if (selected.length >= maxChunks) break;

    const cleaned = normalizeWhitespace(chunk.text);
    if (!cleaned) continue;

    const lowerCleaned = cleaned.toLowerCase();
    const isDuplicateOrContained = keptNormalized.some(
      (prev) =>
        prev === lowerCleaned ||
        (lowerCleaned.length >= 40 && prev.includes(lowerCleaned))
    );
    if (isDuplicateOrContained) {
      continue;
    }

    const pageKey = `${chunk.document_id}:${chunk.page_number}`;
    const existingPageWords = pageWordsMap.get(pageKey) ?? [];
    let words = cleaned.split(" ");

    if (existingPageWords.length > 0) {
      const stripped = stripSamePageOverlap(words, existingPageWords);
      if (stripped.length === 0) {
        continue;
      }
      words = stripped;
    }

    const effectiveText = trimSentenceBoundary(words.join(" "), maxChunkChars);
    const effectiveWords = effectiveText.split(" ");
    const candidateShingles = buildShingles(effectiveWords);

    if (selected.length > 0 && hasHighShingleOverlap(candidateShingles, keptShingles)) {
      continue;
    }

    selected.push({ chunk, promptText: effectiveText });
    keptNormalized.push(lowerCleaned);
    if (candidateShingles.size > 0) {
      keptShingles.push(candidateShingles);
    }
    pageWordsMap.set(pageKey, [...existingPageWords, cleaned.split(" ")]);
  }

  return selected;
}

const PASSAGE_SEPARATOR = "\n\n---\n\n";

export function buildOptimizedRagPrompt(
  question: string,
  chunks: RetrievedChunkRef[],
  options: RagPromptOptions = {}
): OptimizedPromptResult {
  const maxContextChars = options.maxContextChars ?? RAG_MAX_CONTEXT_CHARS;
  const maxChunkChars = options.maxChunkChars ?? RAG_MAX_CHUNK_CHARS;
  const optimized = optimizeChunksForPrompt(chunks, options);
  let contextBlock = "(No matching document passages were retrieved.)";
  const included: OptimizedPassage[] = [];

  if (optimized.length > 0) {
    const formattedPassages: string[] = [];
    let totalChars = 0;
    // Ensure higher topK selections distribute budget fairly instead of allowing early chunks to starve later ones.
    const perPassageTextCap =
      optimized.length > 3
        ? Math.min(maxChunkChars, Math.max(420, Math.floor((maxContextChars - optimized.length * 120) / optimized.length)))
        : maxChunkChars;

    for (const item of optimized) {
      const { chunk } = item;
      const header = `[Passage ${formattedPassages.length + 1} | File: ${chunk.filename} | Page: ${chunk.page_number} | Chunk ID: ${chunk.chunk_id}]\n`;
      const sepCost = formattedPassages.length > 0 ? PASSAGE_SEPARATOR.length : 0;
      const remainingTotalBudget = maxContextChars - totalChars - sepCost - header.length;

      if (formattedPassages.length > 0 && remainingTotalBudget < 160) {
        break;
      }

      const maxAllowedText = Math.min(
        perPassageTextCap,
        Math.max(120, remainingTotalBudget)
      );
      const boundedText = trimSentenceBoundary(item.promptText, maxAllowedText);
      const entry = `${header}${boundedText}`;

      if (formattedPassages.length > 0 && totalChars + sepCost + entry.length > maxContextChars) {
        break;
      }

      formattedPassages.push(entry);
      included.push({ chunk, promptText: boundedText });
      totalChars += sepCost + entry.length;
    }
    contextBlock = formattedPassages.join(PASSAGE_SEPARATOR);
  }

  const promptPreview = `<retrieved_context>\n${contextBlock}\n</retrieved_context>\n\nUser Question: ${question}`;
  return {
    promptPreview,
    passages: included,
    originalChunksCount: chunks.length,
    deduplicatedChunksCount: included.length,
    contextChars: contextBlock.length,
  };
}

export function redactSecrets(message: string): string {
  let sanitized = String(message ?? "");
  const secretEnvKeys = [
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
    "DATABASE_URL",
    "BLOB_READ_WRITE_TOKEN",
  ];

  for (const key of secretEnvKeys) {
    const raw = process.env[key]?.trim();
    if (!raw) continue;
    const strippedBearer = raw.replace(/^Bearer\s+/i, "").trim();
    for (const candidate of [raw, strippedBearer]) {
      if (candidate.length >= 6 && sanitized.includes(candidate)) {
        sanitized = sanitized.split(candidate).join("***");
      }
    }
  }

  return sanitized
    .replace(/([?&]key=)[^&\s'"`]+/gi, "$1***")
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, "Bearer ***")
    .replace(/(https?:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/)[^/\s]+/gi, "$1***")
    .replace(/postgres(?:ql)?:\/\/[^\s'"`]+@/gi, "postgresql://***@");
}
