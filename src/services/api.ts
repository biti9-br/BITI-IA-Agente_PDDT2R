import { auth } from "../firebase";

/**
 * Cliente HTTP unificado para todas as chamadas às rotas /api/*.
 * 
 * Regras:
 * - obtém o token com await auth.currentUser.getIdToken()
 * - adiciona o header Authorization: Bearer <token> preservando os demais headers
 * - NÃO define Content-Type quando o body for FormData (o navegador define o boundary)
 * - se a resposta for 401, obtém um token novo com getIdToken(true) e repete a chamada UMA vez
 * - se não houver usuário logado, lança erro e redireciona para a tela de login
 */
export async function apiFetch(url: RequestInfo | URL, options?: RequestInit): Promise<Response> {
  // Antes de ler auth.currentUser, aguarda obrigatoriamente a inicialização do Firebase Auth
  if (typeof auth.authStateReady === "function") {
    await auth.authStateReady();
  }

  const currentUser = auth.currentUser;
  if (!currentUser) {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event("auth-required"));
    }
    throw new Error("Usuário não autenticado. Faça login para continuar.");
  }

  // 1. apiFetch deve enviar o Firebase ID token obtido com await auth.currentUser.getIdToken() a cada requisição,
  // e NUNCA o token da Microsoft (accessToken do credentialFromResult). O token da Microsoft é usado somente nas chamadas a graph.microsoft.com.
  let token = await currentUser.getIdToken();

  const prepareHeaders = (authToken: string): Headers => {
    const headers = new Headers(options?.headers || {});
    // Garante que o cabeçalho Authorization seja estritamente o Firebase ID Token
    headers.set("Authorization", `Bearer ${authToken}`);

    // NÃO define Content-Type quando o body for FormData (o navegador define o boundary)
    if (options?.body instanceof FormData) {
      headers.delete("Content-Type");
      headers.delete("content-type");
    }

    return headers;
  };

  let response = await fetch(url, {
    ...options,
    headers: prepareHeaders(token),
  });

  // se a resposta for 401, obtém um token novo com getIdToken(true) e repete a chamada UMA vez
  if (response.status === 401) {
    try {
      token = await currentUser.getIdToken(true);
      response = await fetch(url, {
        ...options,
        headers: prepareHeaders(token),
      });
    } catch (refreshErr) {
      console.warn("[apiFetch] Falha ao renovar ID token:", refreshErr);
    }
    // 3. NÃO DESLOGAR POR ERRO DE API:
    // Nenhuma resposta 401, 403 ou 500 de /api pode chamar signOut().
    // Em 401, apiFetch renova o token uma vez; se continuar, apenas retorna a resposta para exibição do erro sem deslogar.
  }

  return response;
}
