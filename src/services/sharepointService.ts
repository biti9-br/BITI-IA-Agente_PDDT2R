import { getMemoryToken, reautenticarMicrosoft } from "../auth";
import { SHAREPOINT_HOSTNAME, SHAREPOINT_SITE_PATH, SHAREPOINT_LIBRARY } from "../config/sharepoint";

export interface SharePointItem {
  id: string;
  name: string;
  size?: number;
  lastModifiedDateTime?: string;
  folder?: {
    childCount: number;
  };
  file?: {
    mimeType: string;
  };
  webUrl?: string;
  parentReference?: {
    driveId?: string;
    id?: string;
    path?: string;
  };
}

export interface SharePointListResponse {
  items: SharePointItem[];
  nextLink?: string;
}

export interface GraphLogEntry {
  id: string;
  timestamp: string;
  url: string;
  status: number;
  statusText?: string;
  response: any;
  error?: string;
}

let graphLogs: GraphLogEntry[] = [];
const logListeners: Array<(logs: GraphLogEntry[]) => void> = [];

export function getGraphLogs(): GraphLogEntry[] {
  return [...graphLogs];
}

export function clearGraphLogs(): void {
  graphLogs = [];
  logListeners.forEach((cb) => cb([...graphLogs]));
}

function addGraphLog(entry: Omit<GraphLogEntry, "id" | "timestamp">) {
  const newEntry: GraphLogEntry = {
    ...entry,
    id: `log_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    timestamp: new Date().toLocaleTimeString("pt-BR", { hour12: false }),
  };
  graphLogs = [newEntry, ...graphLogs].slice(0, 50); // Mantém as 50 chamadas mais recentes
  logListeners.forEach((cb) => cb([...graphLogs]));
}

export function subscribeGraphLogs(callback: (logs: GraphLogEntry[]) => void): () => void {
  logListeners.push(callback);
  callback([...graphLogs]);
  return () => {
    const idx = logListeners.indexOf(callback);
    if (idx !== -1) logListeners.splice(idx, 1);
  };
}

export class GraphError extends Error {
  statusCode: number;
  graphCode?: string;

  constructor(statusCode: number, message: string, graphCode?: string) {
    super(message);
    this.name = "GraphError";
    this.statusCode = statusCode;
    this.graphCode = graphCode;
  }
}

/**
 * Executa chamadas GET autenticadas à API Microsoft Graph.
 * Segue estritamente as regras:
 * - Apenas chamadas GET (somente leitura).
 * - Token exclusivamente em memória.
 * - Em caso de 401, reautentica com popup e repete a chamada uma única vez.
 * - Tratamento estrito de erros (401, 403, 404 e outros).
 * - Registra cada chamada, status HTTP e JSON de resposta para o painel de diagnóstico.
 */
async function callGraphGet<T>(
  url: string,
  responseType: "json" | "blob" = "json",
  isRetry = false
): Promise<T> {
  let token = getMemoryToken();

  // Se o token em memória ainda não estiver disponível, solicita autenticação
  if (!token) {
    try {
      token = await reautenticarMicrosoft();
    } catch (authErr: any) {
      throw new GraphError(401, "Sua sessão expirou. Entre novamente.");
    }
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: responseType === "blob" ? "*/*" : "application/json",
      },
    });
  } catch (netErr: any) {
    addGraphLog({
      url,
      status: 0,
      statusText: "Erro de Rede",
      response: { error: netErr.message || "Falha de conexão com a Microsoft Graph API" },
      error: netErr.message,
    });
    throw netErr;
  }

  // Clona e extrai o corpo de resposta para diagnóstico sem consumir o body stream principal
  let responseBodyForLog: any = null;
  try {
    const clone = response.clone();
    if (responseType === "blob" && response.ok) {
      responseBodyForLog = {
        type: "blob",
        contentType: response.headers.get("content-type") || "application/octet-stream",
        contentLength: response.headers.get("content-length") || "desconhecido",
      };
    } else {
      responseBodyForLog = await clone.json();
    }
  } catch {
    try {
      const textClone = await response.clone().text();
      responseBodyForLog = textClone ? { text: textClone } : "(corpo vazio)";
    } catch {
      responseBodyForLog = "(não foi possível ler o corpo)";
    }
  }

  // Registra no histórico de diagnóstico
  addGraphLog({
    url,
    status: response.status,
    statusText: response.statusText,
    response: responseBodyForLog,
  });

  // 1. Trata 401 (Sessão expirada): tenta reautenticar via popup e repete a chamada
  if (response.status === 401) {
    if (!isRetry) {
      try {
        const freshToken = await reautenticarMicrosoft();
        if (freshToken) {
          return await callGraphGet<T>(url, responseType, true);
        }
      } catch {
        // Falha no popup ou cancelado pelo usuário
      }
    }
    throw new GraphError(401, "Sua sessão expirou. Entre novamente.");
  }

  // 2. Trata 403 (Sem permissão)
  if (response.status === 403) {
    throw new GraphError(403, "Você não tem permissão para acessar este conteúdo no SharePoint.");
  }

  // 3. Trata 404 (Não encontrado)
  if (response.status === 404) {
    throw new GraphError(404, "Site ou biblioteca não encontrados. Verifique a configuração.");
  }

  // 4. Outros erros retornados pelo Graph
  if (!response.ok) {
    let errorMsg = `Erro ${response.status}: ${response.statusText}`;
    let graphCode = "";
    if (responseBodyForLog?.error) {
      graphCode = responseBodyForLog.error.code || "";
      errorMsg = responseBodyForLog.error.message || errorMsg;
    }
    const fullMsg = graphCode ? `[${graphCode}] ${errorMsg}` : errorMsg;
    throw new GraphError(response.status, fullMsg, graphCode);
  }

  // Sucesso
  if (responseType === "blob") {
    const blob = await response.blob();
    return blob as unknown as T;
  }

  return (await response.json()) as T;
}

/**
 * 1. Resolve o site do SharePoint:
 * GET https://graph.microsoft.com/v1.0/sites/{SHAREPOINT_HOSTNAME}:{SHAREPOINT_SITE_PATH}
 * Com fallbacks resilientes para tenants corporativos delegados.
 */
export async function resolverSiteId(): Promise<string> {
  const cleanHost = SHAREPOINT_HOSTNAME.replace(/[\[\]]/g, "")
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "")
    .trim();
  let cleanPath = SHAREPOINT_SITE_PATH.replace(/[\[\]]/g, "").trim();
  if (!cleanPath.startsWith("/")) {
    cleanPath = `/${cleanPath}`;
  }
  const siteName = cleanPath.split("/").filter(Boolean).pop() || "portfolio";

  // Tentativa 1: Formato padrão documentado pelo Graph
  try {
    const url = `https://graph.microsoft.com/v1.0/sites/${cleanHost}:${cleanPath}`;
    const data = await callGraphGet<{ id: string; name?: string; webUrl?: string }>(url);
    if (data?.id) return data.id;
  } catch (err: any) {
    console.warn("Tentativa 1 de resolução de site falhou:", err.message);
  }

  // Tentativa 2: Formato com /sites/root:{cleanPath}
  try {
    const urlRoot = `https://graph.microsoft.com/v1.0/sites/root:${cleanPath}`;
    const data = await callGraphGet<{ id: string; name?: string; webUrl?: string }>(urlRoot);
    if (data?.id) return data.id;
  } catch (err: any) {
    console.warn("Tentativa 2 de resolução via root falhou:", err.message);
  }

  // Tentativa 3: Busca direta pelo nome do site
  try {
    const urlSearch = `https://graph.microsoft.com/v1.0/sites?search=${encodeURIComponent(siteName)}`;
    const data = await callGraphGet<{ value: Array<{ id: string; name: string; webUrl?: string }> }>(urlSearch);
    const sites = data?.value || [];
    const matched = sites.find(
      (s) =>
        s.name.toLowerCase() === siteName.toLowerCase() ||
        (s.webUrl && s.webUrl.toLowerCase().includes(siteName.toLowerCase()))
    );
    if (matched?.id) return matched.id;
    if (sites.length > 0 && sites[0].id) return sites[0].id;
  } catch (err: any) {
    console.warn("Tentativa 3 de busca de site falhou:", err.message);
  }

  // Tentativa 4: Formato /sites/root:/sites/{siteName}
  try {
    const urlRootSite = `https://graph.microsoft.com/v1.0/sites/root:/sites/${encodeURIComponent(siteName)}`;
    const data = await callGraphGet<{ id: string; name?: string; webUrl?: string }>(urlRootSite);
    if (data?.id) return data.id;
  } catch (err: any) {
    console.warn("Tentativa 4 via root:/sites/{site} falhou:", err.message);
  }

  throw new GraphError(
    404,
    `Site ou biblioteca não encontrados. Verifique a configuração (${cleanHost}${cleanPath}).`
  );
}

/**
 * 2. Encontra a biblioteca de documentos (Drive) configurada:
 * GET https://graph.microsoft.com/v1.0/sites/{site-id}/drives
 * Aceita o drive cujo "name" seja igual a 'Projetos' OU cujo "webUrl" termine com '/Projetos'.
 * Se nenhum for encontrado ou se /drives vier vazio (típico com Sites.Selected):
 *   - Tenta GET /sites/{site-id}/lists/{list-name}/drive diretamente
 *   - Tenta GET /sites/{site-id}/drive (drive padrão)
 *   - Tenta por path GET /sites/{hostname}:{path}:/lists/{list-name}/drive e /drive
 *   - Tenta GET /sites/{site-id}/lists e busca correspondência
 *   - Se houver apenas 1 drive acessível, utiliza-o
 *   - Se nenhum for encontrado, mostra na mensagem de erro os drives e listas retornados.
 */
export async function encontrarBibliotecaDriveId(siteId: string): Promise<string> {
  const targetLib = SHAREPOINT_LIBRARY.trim();
  const targetLibLower = targetLib.toLowerCase();
  const cleanHost = SHAREPOINT_HOSTNAME.replace(/[\[\]]/g, "")
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "")
    .trim();
  let cleanPath = SHAREPOINT_SITE_PATH.replace(/[\[\]]/g, "").trim();
  if (!cleanPath.startsWith("/")) {
    cleanPath = `/${cleanPath}`;
  }

  // 1. Tenta listar drives disponíveis no site
  let drives: Array<{ id: string; name: string; driveType?: string; webUrl?: string }> = [];
  try {
    const url = `https://graph.microsoft.com/v1.0/sites/${siteId}/drives`;
    const data = await callGraphGet<{
      value: Array<{ id: string; name: string; driveType?: string; webUrl?: string }>;
    }>(url);
    drives = data?.value || [];
  } catch (err: any) {
    console.warn("Falha ao consultar /drives:", err.message);
  }

  // Se houver drives retornados, tenta encontrar o drive pelo nome ou webUrl
  if (drives.length > 0) {
    const drive = drives.find((d) => {
      const name = d.name?.trim() || "";
      const webUrl = d.webUrl?.trim() || "";
      const nameMatch = name === targetLib || name.toLowerCase() === targetLibLower;
      const urlMatch =
        webUrl.endsWith(`/${targetLib}`) ||
        webUrl.toLowerCase().endsWith(`/${targetLibLower}`);
      return nameMatch || urlMatch;
    });

    if (drive?.id) {
      return drive.id;
    }
  }

  // 2. Alternativa: Tenta acessar diretamente a lista pelo nome da biblioteca para obter seu drive:
  // GET /sites/{site-id}/lists/{list-title}/drive
  try {
    const listDriveUrl = `https://graph.microsoft.com/v1.0/sites/${siteId}/lists/${encodeURIComponent(targetLib)}/drive`;
    const listDriveData = await callGraphGet<{ id: string; name?: string; webUrl?: string }>(listDriveUrl);
    if (listDriveData?.id) {
      return listDriveData.id;
    }
  } catch (err: any) {
    console.warn("Tentativa direta via /lists/{targetLib}/drive falhou:", err.message);
  }

  // 3. Alternativa: Tenta obter o drive padrão do site:
  // GET /sites/{site-id}/drive
  try {
    const defaultDriveUrl = `https://graph.microsoft.com/v1.0/sites/${siteId}/drive`;
    const defaultDriveData = await callGraphGet<{ id: string; name?: string; webUrl?: string }>(defaultDriveUrl);
    if (defaultDriveData?.id) {
      return defaultDriveData.id;
    }
  } catch (err: any) {
    console.warn("Tentativa de drive padrão /sites/{site-id}/drive falhou:", err.message);
  }

  // 4. Alternativa via URL canônica do site por path:
  // GET /sites/{hostname}:{path}:/lists/{targetLib}/drive
  try {
    const directPathDriveUrl = `https://graph.microsoft.com/v1.0/sites/${cleanHost}:${cleanPath}:/lists/${encodeURIComponent(targetLib)}/drive`;
    const directPathDriveData = await callGraphGet<{ id: string; name?: string; webUrl?: string }>(directPathDriveUrl);
    if (directPathDriveData?.id) {
      return directPathDriveData.id;
    }
  } catch (err: any) {
    console.warn("Tentativa via /sites/{path}:/lists/{targetLib}/drive falhou:", err.message);
  }

  // 5. Alternativa via URL canônica do drive do site por path:
  // GET /sites/{hostname}:{path}:/drive
  try {
    const directSiteDriveUrl = `https://graph.microsoft.com/v1.0/sites/${cleanHost}:${cleanPath}:/drive`;
    const directSiteDriveData = await callGraphGet<{ id: string; name?: string; webUrl?: string }>(directSiteDriveUrl);
    if (directSiteDriveData?.id) {
      return directSiteDriveData.id;
    }
  } catch (err: any) {
    console.warn("Tentativa via /sites/{path}:/drive falhou:", err.message);
  }

  // 6. Alternativa: Consultar /lists (tanto com $select quanto sem) e procurar correspondência
  let lists: Array<{ id: string; displayName?: string; name?: string; webUrl?: string }> = [];
  try {
    const listsUrl = `https://graph.microsoft.com/v1.0/sites/${siteId}/lists?$select=id,displayName,name,webUrl`;
    const listsData = await callGraphGet<{
      value: Array<{ id: string; displayName?: string; name?: string; webUrl?: string }>;
    }>(listsUrl);
    lists = listsData?.value || [];
  } catch {
    try {
      const listsUrlPlain = `https://graph.microsoft.com/v1.0/sites/${siteId}/lists`;
      const listsDataPlain = await callGraphGet<{
        value: Array<{ id: string; displayName?: string; name?: string; webUrl?: string }>;
      }>(listsUrlPlain);
      lists = listsDataPlain?.value || [];
    } catch (plainErr: any) {
      console.warn("Tentativa de consultar /lists falhou:", plainErr.message);
    }
  }

  if (lists.length > 0) {
    const listaEncontrada = lists.find((l) => {
      const dName = l.displayName?.trim() || "";
      const name = l.name?.trim() || "";
      const webUrl = l.webUrl?.trim() || "";
      const nameMatch =
        dName === targetLib ||
        dName.toLowerCase() === targetLibLower ||
        name === targetLib ||
        name.toLowerCase() === targetLibLower;
      const urlMatch =
        webUrl.endsWith(`/${targetLib}`) ||
        webUrl.toLowerCase().endsWith(`/${targetLibLower}`);
      return nameMatch || urlMatch;
    });

    if (listaEncontrada?.id) {
      try {
        const listDriveUrl = `https://graph.microsoft.com/v1.0/sites/${siteId}/lists/${listaEncontrada.id}/drive`;
        const listDriveData = await callGraphGet<{ id: string; name?: string; webUrl?: string }>(listDriveUrl);
        if (listDriveData?.id) {
          return listDriveData.id;
        }
      } catch (err: any) {
        console.warn("Erro ao obter drive da lista encontrada:", err.message);
      }
    }
  }

  // 7. Se houver apenas 1 drive acessível retornado, utiliza-o
  if (drives.length === 1 && drives[0].id) {
    console.info(`Usando o único drive disponível no site: "${drives[0].name}"`);
    return drives[0].id;
  }

  const driveNames = drives.map((d) => d.name || "(sem nome)").join(", ");
  const listNames = lists.map((l) => l.displayName || l.name || "(sem nome)").join(", ");
  const detalhe = [
    driveNames ? `Drives retornados: [${driveNames}]` : "Drives vieram vazios",
    listNames ? `Listas retornadas: [${listNames}]` : "Listas vieram vazias",
  ].join(". ");

  throw new GraphError(
    404,
    `Biblioteca '${SHAREPOINT_LIBRARY}' não foi encontrada no site. ${detalhe}. Abra o painel de Diagnóstico para ver os detalhes das respostas do Microsoft Graph.`
  );
}

/**
 * 3. Listar conteúdo de uma pasta ou raiz da biblioteca:
 * Raiz: GET https://graph.microsoft.com/v1.0/drives/{drive-id}/root/children
 * Pasta: GET https://graph.microsoft.com/v1.0/drives/{drive-id}/items/{item-id}/children
 */
export async function listarItensSharePoint(
  driveId: string,
  folderItemId?: string
): Promise<SharePointListResponse> {
  const url = folderItemId
    ? `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${folderItemId}/children`
    : `https://graph.microsoft.com/v1.0/drives/${driveId}/root/children`;

  const data = await callGraphGet<{ value: SharePointItem[]; "@odata.nextLink"?: string }>(url);
  return {
    items: data?.value || [],
    nextLink: data?.["@odata.nextLink"],
  };
}

/**
 * 4. Paginação: se a resposta tiver @odata.nextLink, carregar os próximos itens
 */
export async function carregarProximosItensSharePoint(
  nextLinkUrl: string
): Promise<SharePointListResponse> {
  const data = await callGraphGet<{ value: SharePointItem[]; "@odata.nextLink"?: string }>(nextLinkUrl);
  return {
    items: data?.value || [],
    nextLink: data?.["@odata.nextLink"],
  };
}

/**
 * 5. Baixar o arquivo escolhido:
 * GET https://graph.microsoft.com/v1.0/drives/{drive-id}/items/{item-id}/content
 * Retorna o conteúdo binário como Blob.
 */
export async function baixarArquivoSharePoint(
  driveId: string,
  itemId: string
): Promise<Blob> {
  const url = `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}/content`;
  return await callGraphGet<Blob>(url, "blob");
}
