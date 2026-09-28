import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { defineSecret } from "firebase-functions/params";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { initializeApp, getApps } from "firebase-admin/app";
import { gerarEmbedding } from "./embeddings";

// Declaração do segredo GEMINI_API_KEY gerenciado pelo Secret Manager
const geminiApiKey = defineSecret("GEMINI_API_KEY");

if (getApps().length === 0) {
  initializeApp();
}

const db = getFirestore();

export const indexarMensagensNovas = onDocumentWritten(
  {
    document: "users/{uid}/conversas/{conversaId}",
    secrets: [geminiApiKey],
  },
  async (event) => {
    const uid = event.params.uid;
    const conversaId = event.params.conversaId;

    const dadosDepois = event.data?.after.data();
    if (!dadosDepois) return; // documento foi apagado

    const mensagens: { role: string; content: string }[] = dadosDepois.mensagens || [];
    const jaIndexadas: number = dadosDepois.mensagensIndexadas || 0;

    const novasMensagens = mensagens.slice(jaIndexadas);
    if (novasMensagens.length === 0) return; // nada novo pra indexar

    const apiKey = geminiApiKey.value() || process.env.GEMINI_API_KEY;
    const batch = db.batch();

    for (let i = 0; i < novasMensagens.length; i++) {
      const msg = novasMensagens[i];
      if (!msg.content || typeof msg.content !== "string") continue;

      const embedding = await gerarEmbedding(msg.content, apiKey);

      const chunkRef = db.collection("chunks").doc();

      batch.set(chunkRef, {
        uid,
        conversaId,
        role: msg.role || "user",
        texto: msg.content,
        embedding: embedding && embedding.length > 0 ? embedding : [],
        posicao: jaIndexadas + i,
        criadoEm: FieldValue.serverTimestamp(),
      });
    }

    // Atualiza o contador de mensagens indexadas na conversa
    const conversaRef = event.data?.after.ref;
    if (conversaRef) {
      batch.update(conversaRef, {
        mensagensIndexadas: mensagens.length,
      });
    }

    await batch.commit();
  }
);
