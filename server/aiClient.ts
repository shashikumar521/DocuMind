import {
  CF_COMPARE_TOTAL_BUDGET_MS,
  embedCloudflareQuery,
  formatCloudflareError,
  generateCloudflareEmbeddings,
  generateCloudflareRagAnswer,
  generateCloudflareWithoutRagAnswer,
  getCloudflareChatModel,
  getCloudflareEmbeddingModel,
  getCloudflareExpectedEmbeddingDimensions,
  isCloudflareConfigured,
} from "./cloudflareClient.js";
import {
  embedQuery as embedGeminiQuery,
  formatGeminiError,
  GEMINI_COMPARE_TOTAL_BUDGET_MS,
  GEMINI_EMBEDDING_MODEL,
  generateEmbeddings as generateGeminiEmbeddings,
  generateRagAnswer as generateGeminiRagAnswer,
  generateWithoutRagAnswer as generateGeminiWithoutRagAnswer,
  getGeminiChatModel,
  isGeminiConfigured,
  RetrievedChunkRef,
} from "./geminiClient.js";

export type AiProvider = "gemini" | "cloudflare";

export const GEMINI_EMBEDDING_DIMENSIONS = 3072;

export function getActiveAiProvider(): AiProvider {
  const configured = process.env.AI_PROVIDER?.trim().toLowerCase();
  if (configured === "cloudflare") {
    return "cloudflare";
  }
  return "gemini";
}

export function getActiveChatModel(provider: AiProvider = getActiveAiProvider()): string {
  return provider === "cloudflare" ? getCloudflareChatModel() : getGeminiChatModel();
}

export function getActiveEmbeddingModel(provider: AiProvider = getActiveAiProvider()): string {
  return provider === "cloudflare" ? getCloudflareEmbeddingModel() : GEMINI_EMBEDDING_MODEL;
}

export function getExpectedEmbeddingDimensions(
  provider: AiProvider = getActiveAiProvider()
): number {
  return provider === "cloudflare"
    ? getCloudflareExpectedEmbeddingDimensions()
    : GEMINI_EMBEDDING_DIMENSIONS;
}

export function isAiConfigured(provider: AiProvider = getActiveAiProvider()): boolean {
  return provider === "cloudflare" ? isCloudflareConfigured() : isGeminiConfigured();
}

export function getCompareTotalBudgetMs(provider: AiProvider = getActiveAiProvider()): number {
  return provider === "cloudflare"
    ? CF_COMPARE_TOTAL_BUDGET_MS
    : GEMINI_COMPARE_TOTAL_BUDGET_MS;
}

function assertProviderVectorsValid(
  vectors: number[][],
  provider: AiProvider,
  model: string
): number[][] {
  const expectedDims = getExpectedEmbeddingDimensions(provider);
  for (const vec of vectors) {
    if (!Array.isArray(vec) || vec.length !== expectedDims) {
      throw new Error(
        `Embedding dimension mismatch for ${provider} (${model}): expected ${expectedDims}, received ${Array.isArray(vec) ? vec.length : 0}.`
      );
    }
  }
  return vectors;
}

export async function generateEmbeddings(
  texts: string[],
  provider: AiProvider = getActiveAiProvider()
): Promise<number[][]> {
  const model = getActiveEmbeddingModel(provider);
  const vectors =
    provider === "cloudflare"
      ? await generateCloudflareEmbeddings(texts)
      : await generateGeminiEmbeddings(texts);
  return assertProviderVectorsValid(vectors, provider, model);
}

export async function embedQuery(
  question: string,
  provider: AiProvider = getActiveAiProvider()
): Promise<number[]> {
  const model = getActiveEmbeddingModel(provider);
  const vector =
    provider === "cloudflare"
      ? await embedCloudflareQuery(question)
      : await embedGeminiQuery(question);
  assertProviderVectorsValid([vector], provider, model);
  return vector;
}

export async function generateRagAnswer(
  question: string,
  chunks: RetrievedChunkRef[],
  options: { totalBudgetMs?: number; provider?: AiProvider } = {}
): Promise<{ answer: string; promptPreview: string }> {
  const provider = options.provider ?? getActiveAiProvider();
  if (provider === "cloudflare") {
    return generateCloudflareRagAnswer(question, chunks, options);
  }
  return generateGeminiRagAnswer(question, chunks, options);
}

export async function generateWithoutRagAnswer(
  question: string,
  options: { totalBudgetMs?: number; provider?: AiProvider } = {}
): Promise<string> {
  const provider = options.provider ?? getActiveAiProvider();
  if (provider === "cloudflare") {
    return generateCloudflareWithoutRagAnswer(question, options);
  }
  return generateGeminiWithoutRagAnswer(question, options);
}

export function formatAiError(
  err: unknown,
  provider: AiProvider = getActiveAiProvider()
): { status: number; message: string } {
  if (provider === "cloudflare") {
    const cfFormatted = formatCloudflareError(err);
    if (cfFormatted.status !== 500 || !isGeminiErrorInstance(err)) {
      return cfFormatted;
    }
  }
  return formatGeminiError(err);
}

function isGeminiErrorInstance(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.name === "GeminiConfigError" ||
    err.name === "GeminiRateLimitError" ||
    err.name === "GeminiQuotaExhaustedError"
  );
}

export type { RetrievedChunkRef };
