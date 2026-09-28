import { GoogleGenAI } from "@google/genai";

/**
 * Gera o vetor de embedding (768 dimensões com text-embedding-004) para o texto fornecido.
 * Compatível diretamente com o índice vetorial criado no Firestore com dimensão 768.
 */
export async function gerarEmbedding(texto: string, apiKey?: string): Promise<number[]> {
  const key = apiKey || process.env.GEMINI_API_KEY;
  if (!key) {
    console.warn("[gerarEmbedding] GEMINI_API_KEY não encontrada.");
    return [];
  }

  try {
    const ai = new GoogleGenAI({ apiKey: key });
    const resp = await ai.models.embedContent({
      model: "text-embedding-004",
      contents: texto,
    });

    const values = (resp as any).embedding?.values ||
                   (Array.isArray((resp as any).embeddings) ? (resp as any).embeddings[0]?.values : null);

    return values && Array.isArray(values) ? values : [];
  } catch (error) {
    console.error("[gerarEmbedding] Erro ao gerar embedding:", error);
    return [];
  }
}
