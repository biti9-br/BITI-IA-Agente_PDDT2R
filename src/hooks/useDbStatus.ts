import { useState, useEffect, useRef, useCallback } from "react";
import { ClientGroup } from "../types";
import { apiFetch } from "../services/api";

export interface DbStatusState {
  mode: "real" | "demo";
  rootFolderId: string;
  rootFolderName: string;
  fileCount: number;
  chunkCount: number;
  clientGroups: ClientGroup[];
}

export function useDbStatus(userEmail: string) {
  const [loading, setLoading] = useState(false);
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);
  const [dbStatus, setDbStatus] = useState<DbStatusState>({
    mode: "demo",
    rootFolderId: "",
    rootFolderName: "",
    fileCount: 0,
    chunkCount: 0,
    clientGroups: []
  });

  const [activeSessionId, setActiveSessionId] = useState<string>(() => {
    return localStorage.getItem("biti9_active_session_id") || "default_session";
  });

  const abortControllerRef = useRef<AbortController | null>(null);
  const isInitialMountRef = useRef(true);
  const knownFileIdsRef = useRef<Set<string>>(new Set());

  // Carrega status e arquivos do Banco de Vetores para a conversa ativa
  const loadDbStatus = useCallback(async (targetSessionId?: string) => {
    if (!userEmail) {
      // Usuário não autenticado: não executa chamada para evitar erro de autorização
      return;
    }

    const sessId = targetSessionId || activeSessionId;

    // Cancela requisição anterior se houver para evitar sobrescrever com dados antigos
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    const controller = new AbortController();
    abortControllerRef.current = controller;

    // 1. Reset imediato de estado para feedback visual instantâneo na UI
    setDbStatus(prev => ({
      ...prev,
      clientGroups: [],
      fileCount: 0,
      chunkCount: 0
    }));
    setSelectedFileIds([]);
    setLoading(true);

    try {
      const res = await apiFetch(`/api/conversations/${encodeURIComponent(sessId)}/sources`, {
        signal: controller.signal
      });

      if (res.ok) {
        const data = await res.json();
        // Apenas atualiza se este ainda for o controller ativo mais recente
        if (abortControllerRef.current === controller) {
          setDbStatus({
            mode: data.mode || "demo",
            rootFolderId: data.rootFolderId || "",
            rootFolderName: data.rootFolderName || "",
            fileCount: data.fileCount || 0,
            chunkCount: data.chunkCount || 0,
            clientGroups: data.clientGroups || []
          });
        }
      }
    } catch (e: any) {
      if (e.name === "AbortError") {
        // Ignorar requisições abortadas ao alternar rapidamente entre conversas
        return;
      }
      if (e?.message?.includes("Usuário não autenticado") || !userEmail) {
        return;
      }
      console.error("Erro ao carregar dados do banco de dados", e);
    } finally {
      if (abortControllerRef.current === controller) {
        setLoading(false);
      }
    }
  }, [activeSessionId, userEmail]);

  useEffect(() => {
    if (!userEmail) {
      setDbStatus({
        mode: "demo",
        rootFolderId: "",
        rootFolderName: "",
        fileCount: 0,
        chunkCount: 0,
        clientGroups: []
      });
      setSelectedFileIds([]);
      setLoading(false);
      return;
    }

    loadDbStatus(activeSessionId);
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, [activeSessionId, loadDbStatus, userEmail]);

  const handleSessionChange = useCallback((newSessionId: string) => {
    setDbStatus(prev => ({
      ...prev,
      clientGroups: [],
      fileCount: 0,
      chunkCount: 0
    }));
    setSelectedFileIds([]);
    setActiveSessionId(newSessionId);
    localStorage.setItem("biti9_active_session_id", newSessionId);
    if (userEmail) {
      loadDbStatus(newSessionId);
    }
  }, [loadDbStatus, userEmail]);

  // Sincroniza selectedFileIds para marcar fontes no primeiro load e gerenciar novos uploads/deleções
  useEffect(() => {
    const allFileIds: string[] = [];
    dbStatus.clientGroups.forEach(client => {
      client.robots.forEach(robot => {
        robot.documents.forEach(doc => {
          allFileIds.push(doc.id);
        });
      });
    });

    if (allFileIds.length === 0) return;

    setSelectedFileIds(prev => {
      // 1. Filtra IDs que não existem mais no sistema (arquivos excluídos)
      const nextSelection = prev.filter(id => allFileIds.includes(id));
      let changed = nextSelection.length !== prev.length;

      // 2. Na primeira carga inicial da aplicação, inicializa limpo (sem documentos marcados por padrão)
      if (isInitialMountRef.current) {
        isInitialMountRef.current = false;
      } else {
        // 3. Nas cargas subsequentes, adiciona apenas arquivos inéditos (ex: upload recente feito na sessão)
        allFileIds.forEach(id => {
          if (!knownFileIdsRef.current.has(id)) {
            nextSelection.push(id);
            changed = true;
          }
        });
      }

      knownFileIdsRef.current = new Set(allFileIds);
      return changed ? nextSelection : prev;
    });
  }, [dbStatus.clientGroups]);

  const handleToggleFile = useCallback((fileId: string) => {
    setSelectedFileIds(prev => {
      if (prev.includes(fileId)) {
        return prev.filter(id => id !== fileId);
      } else {
        return [...prev, fileId];
      }
    });
  }, []);

  const handleToggleAll = useCallback((checked: boolean) => {
    if (checked) {
      const allFileIds: string[] = [];
      dbStatus.clientGroups.forEach(client => {
        client.robots.forEach(robot => {
          robot.documents.forEach(doc => {
            allFileIds.push(doc.id);
          });
        });
      });
      setSelectedFileIds(allFileIds);
    } else {
      setSelectedFileIds([]);
    }
  }, [dbStatus.clientGroups]);

  return {
    dbStatus,
    loading,
    activeSessionId,
    selectedFileIds,
    setSelectedFileIds,
    loadDbStatus,
    handleSessionChange,
    handleToggleFile,
    handleToggleAll
  };
}

export default useDbStatus;
