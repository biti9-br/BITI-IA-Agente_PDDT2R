"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.indexarMensagensNovas = void 0;
const firestore_1 = require("firebase-functions/v2/firestore");
const params_1 = require("firebase-functions/params");
const firestore_2 = require("firebase-admin/firestore");
const app_1 = require("firebase-admin/app");
const embeddings_1 = require("./embeddings");
// Declaração do segredo GEMINI_API_KEY gerenciado pelo Secret Manager
const geminiApiKey = (0, params_1.defineSecret)("GEMINI_API_KEY");
if ((0, app_1.getApps)().length === 0) {
    (0, app_1.initializeApp)();
}
const db = (0, firestore_2.getFirestore)();
exports.indexarMensagensNovas = (0, firestore_1.onDocumentWritten)({
    document: "users/{uid}/conversas/{conversaId}",
    secrets: [geminiApiKey],
}, async (event) => {
    const uid = event.params.uid;
    const conversaId = event.params.conversaId;
    const dadosDepois = event.data?.after.data();
    if (!dadosDepois)
        return; // documento foi apagado
    const mensagens = dadosDepois.mensagens || [];
    const jaIndexadas = dadosDepois.mensagensIndexadas || 0;
    const novasMensagens = mensagens.slice(jaIndexadas);
    if (novasMensagens.length === 0)
        return; // nada novo pra indexar
    const apiKey = geminiApiKey.value() || process.env.GEMINI_API_KEY;
    const batch = db.batch();
    for (let i = 0; i < novasMensagens.length; i++) {
        const msg = novasMensagens[i];
        if (!msg.content || typeof msg.content !== "string")
            continue;
        const embedding = await (0, embeddings_1.gerarEmbedding)(msg.content, apiKey);
        const chunkRef = db.collection("chunks").doc();
        batch.set(chunkRef, {
            uid,
            conversaId,
            role: msg.role || "user",
            texto: msg.content,
            embedding: embedding && embedding.length > 0 ? embedding : [],
            posicao: jaIndexadas + i,
            criadoEm: firestore_2.FieldValue.serverTimestamp(),
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
});
//# sourceMappingURL=indexarConversas.js.map