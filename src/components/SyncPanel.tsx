import React, { useState, useEffect, useRef } from "react";
import { Folder, RefreshCw, AlertTriangle, Play, Database, FolderPlus, HelpCircle, ArrowRight, ShieldCheck, Terminal, Trash2 } from "lucide-react";

interface SyncPanelProps {
  mode: "real" | "demo";
  rootFolderId: string;
  rootFolderName: string;
  fileCount: number;
  chunkCount: number;
  onRefresh: () => void;
  token: string | null;
  onLoginWithGoogle: () => void;
  onLogout: () => void;
  user: any;
}

export default function SyncPanel({
  mode,
  rootFolderId,
  rootFolderName,
  fileCount,
  chunkCount,
  onRefresh,
  token,
  onLoginWithGoogle,
  onLogout,
  user
}: SyncPanelProps) {
  const [syncing, setSyncing] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [folders, setFolders] = useState<Array<{ id: string; name: string }>>([]);
  const [loadingFolders, setLoadingFolders] = useState(false);
  const [selectedFolderId, setSelectedFolderId] = useState("");
  const [selectedFolderName, setSelectedFolderName] = useState("");
  const [inputFolderLink, setInputFolderLink] = useState("");
  const [loadingFolderName, setLoadingFolderName] = useState(false);
  const [navHistory, setNavHistory] = useState<Array<{ id: string; name: string }>>([
    { id: "root", name: "Meu Drive" }
  ]);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  
  const terminalEndRef = useRef<HTMLDivElement>(null);

  // Utilitário para extrair o ID da pasta do link do Google Drive
  const extractFolderId = (input: string): string => {
    const trimmed = input.trim();
    if (trimmed.includes("drive.google.com")) {
      const match = trimmed.match(/\/folders\/([a-zA-Z0-9_-]+)/);
      if (match && match[1]) {
        return match[1];
      }
    }
    return trimmed;
  };

  const resolveFolderName = async (folderId: string) => {
    if (!token || !folderId) return;
    setLoadingFolderName(true);
    try {
      const res = await fetch(`https://www.googleapis.com/drive/v3/files/${folderId}?fields=name`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        if (data.name) {
          setSelectedFolderName(data.name);
          setLogs(prev => [...prev, `[SISTEMA] Pasta raiz validada com sucesso: "${data.name}"`]);
        }
      } else {
        const errText = await res.text();
        console.error("Erro ao resolver nome da pasta:", errText);
        setLogs(prev => [...prev, `[SISTEMA] Aviso: Não foi possível obter o nome da pasta (verifique as permissões de acesso). Usando ID como nome.`]);
        setSelectedFolderName("Pasta Customizada");
      }
    } catch (err: any) {
      console.error(err);
      setLogs(prev => [...prev, `[SISTEMA] Erro de rede ao validar pasta: ${err.message}`]);
      setSelectedFolderName("Pasta Customizada");
    } finally {
      setLoadingFolderName(false);
    }
  };

  // Carrega pastas do Drive sempre que navega no histórico
  useEffect(() => {
    if (token) {
      loadFolders(navHistory[navHistory.length - 1].id);
    }
  }, [token, navHistory]);

  // Rola logs do terminal para o fim automaticamente
  useEffect(() => {
    if (terminalEndRef.current) {
      terminalEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs]);

  const loadFolders = async (parentId: string) => {
    setLoadingFolders(true);
    try {
      const res = await fetch("/api/drive/list-folders", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ parentId })
      });
      if (res.ok) {
        const data = await res.json();
        setFolders(data);
      } else {
        console.error("Erro ao buscar pastas do Drive");
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingFolders(false);
    }
  };

  const handleFolderClick = (folder: { id: string; name: string }) => {
    setNavHistory(prev => [...prev, folder]);
    setSelectedFolderId(folder.id);
    setSelectedFolderName(folder.name);
    setInputFolderLink(folder.id); // Sincroniza com a entrada de link
  };

  const handleGoBack = () => {
    if (navHistory.length <= 1) return;
    const newHistory = navHistory.slice(0, -1);
    setNavHistory(newHistory);
    const parent = newHistory[newHistory.length - 1];
    if (parent.id === "root") {
      setSelectedFolderId("");
      setSelectedFolderName("");
      setInputFolderLink("");
    } else {
      setSelectedFolderId(parent.id);
      setSelectedFolderName(parent.name);
      setInputFolderLink(parent.id);
    }
  };

  // Sincronização Demonstrativa (Local + Embeddings Reais via Gemini)
  const triggerDemoSync = async () => {
    setSyncing(true);
    setLogs(["[SISTEMA] Iniciando preparação do Banco de Dados Demonstrativo...", "[SISTEMA] Conectando com a API do Gemini (text-embedding-004)..."]);
    try {
      const res = await fetch("/api/db/sync-demo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userEmail: user?.email })
      });
      const data = await res.json();
      if (data.success) {
        setLogs(prev => [...prev, ...data.logs]);
        onRefresh();
        setStatusMessage("Sucesso! Banco de dados demonstrativo sincronizado com embeddings reais.");
      } else {
        setLogs(prev => [...prev, `[ERRO] Falha na sincronização: ${data.error}`]);
        setStatusMessage("Erro ao sincronizar banco demonstrativo.");
      }
    } catch (e: any) {
      setLogs(prev => [...prev, `[ERRO] Ocorreu uma exceção: ${e.message}`]);
      setStatusMessage("Exceção na sincronização demonstrativa.");
    } finally {
      setSyncing(false);
    }
  };

  // Sincronização Real com Google Drive
  const triggerRealSync = async () => {
    if (!token || !selectedFolderId) return;
    setSyncing(true);
    setLogs([
      `[SISTEMA] Iniciando Sincronização de Pasta Real no Drive...`,
      `[SISTEMA] Pasta selecionada: "${selectedFolderName}" (ID: ${selectedFolderId})`,
      `[SISTEMA] Inicializando leitor PDF multimodal do Gemini-2.5-Flash...`
    ]);
    try {
      const res = await fetch("/api/drive/sync-real", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          rootFolderId: selectedFolderId,
          rootFolderName: selectedFolderName,
          userEmail: user?.email
        })
      });
      const data = await res.json();
      if (data.success) {
        setLogs(prev => [...prev, ...data.logs]);
        onRefresh();
        setStatusMessage("Sincronização real com o Google Drive concluída com sucesso!");
      } else {
        setLogs(prev => [...prev, ...data.logs, `[ERRO] Falha: ${data.error}`]);
        setStatusMessage(`Falha na sincronização: ${data.error}`);
      }
    } catch (e: any) {
      setLogs(prev => [...prev, `[ERRO CRÍTICO] Exceção: ${e.message}`]);
      setStatusMessage(`Ocorreu uma exceção: ${e.message}`);
    } finally {
      setSyncing(false);
    }
  };

  // Limpar banco de dados
  const triggerReset = async () => {
    const confirm = window.confirm("Deseja realmente limpar o banco de dados vetorial de PDDs? Todos os fragmentos e índices serão excluídos.");
    if (!confirm) return;

    try {
      const res = await fetch("/api/db/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: token ? "real" : "demo",
          userEmail: user?.email
        })
      });
      if (res.ok) {
        setLogs(["[SISTEMA] Banco de dados vetorial limpo. Prontidão operacional reiniciada."]);
        onRefresh();
        setStatusMessage("Banco de dados vetorial resetado.");
      }
    } catch (e: any) {
      console.error(e);
      setStatusMessage("Erro ao limpar banco de dados.");
    }
  };

  return (
    <div id="sync_panel" className="max-w-4xl mx-auto p-4 lg:p-6 space-y-6">
      
      {/* Intro e Explicação */}
      <div className="bg-[#080B12] rounded-xl p-5 border border-white/5 space-y-4">
        <div className="flex items-start gap-4">
          <div className="bg-[#1B60BC] p-2.5 rounded-lg text-white shadow-xs">
            <HelpCircle className="w-6 h-6" />
          </div>
          <div className="space-y-1">
            <h2 className="text-lg font-bold text-white">Como funciona o Sincronizador de PDDs (RAG)?</h2>
            <p className="text-sm text-slate-400 leading-relaxed">
              O sistema lê arquivos PDF diretamente da estrutura de pastas de Clientes e Robôs. 
              Utilizando o <strong className="text-blue-400 font-semibold">Gemini-2.5-Flash</strong>, ele extrai o text do PDF com OCR inteligente. 
              Em seguida, divide o texto em fragmentos lógicos e gera vetores multidimensionais com o modelo <strong className="text-blue-400 font-semibold">text-embedding-004</strong> para possibilitar buscas semânticas ultrarrápidas no chat.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
          {/* Caixa Modo Demo */}
          <div className={`p-4 rounded-lg border transition-all ${
            mode === "demo" 
              ? "bg-[#080B12] border-amber-500/30 text-amber-300 shadow-[0_0_15px_rgba(245,158,11,0.08)]" 
              : "bg-white/5 border-white/5 text-slate-400"
          }`}>
            <h3 className="font-semibold text-sm flex items-center gap-2 mb-1.5 text-amber-400">
              <Database className="w-4 h-4" />
              1. Modo Demonstrativo
            </h3>
            <p className="text-xs leading-relaxed text-slate-400">
              Ideal para testes rápidos sem conectar contas. O sistema simula uma estrutura corporativa da <strong>biti9</strong> contendo PDDs de exemplo bem estruturados, gerando embeddings de verdade de forma transparente.
            </p>
            {mode === "demo" && (
              <span className="inline-block mt-2 text-[10px] bg-amber-500/10 text-amber-400 border border-amber-500/20 px-2 py-0.5 rounded font-mono uppercase">
                Ativo no momento
              </span>
            )}
          </div>

          {/* Caixa Modo Real */}
          <div className={`p-4 rounded-lg border transition-all ${
            mode === "real" 
              ? "bg-[#080B12] border-emerald-500/30 text-emerald-300 shadow-[0_0_15px_rgba(16,185,129,0.08)]" 
              : "bg-white/5 border-white/5 text-slate-400"
          }`}>
            <h3 className="font-semibold text-sm flex items-center gap-2 mb-1.5 text-emerald-400">
              <ShieldCheck className="w-4 h-4" />
              2. Sincronização Google Drive Real
            </h3>
            <p className="text-xs leading-relaxed text-slate-400">
              Permite conectar com o seu Google Drive, navegar e selecionar uma pasta raiz customizada contendo a árvore estruturada de PDDs dos seus clientes para indexação direta.
            </p>
            {mode === "real" && (
              <span className="inline-block mt-2 text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2 py-0.5 rounded font-mono uppercase">
                Ativo no momento
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Seção Principal de Controles */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        
        {/* Painel de Controle à Esquerda */}
        <div className="bg-[#080B12] border border-white/5 rounded-xl p-5 space-y-4 md:col-span-1">
          <h3 className="font-bold text-slate-200 text-xs uppercase tracking-wider flex items-center gap-2 pb-2 border-b border-white/5">
            <Folder className="w-4 h-4 text-blue-400" />
            Ações Rápidas
          </h3>

          {/* Botão de Conectar Drive */}
          <div className="space-y-2 pb-2 border-b border-white/5">
            {!user ? (
              <button
                onClick={onLoginWithGoogle}
                disabled={syncing}
                className="w-full bg-[#1B60BC] hover:bg-[#154FA0] text-white font-medium py-2.5 px-4 rounded-lg text-xs transition-all flex items-center justify-center gap-2 disabled:opacity-50 shadow-xs cursor-pointer"
              >
                <FolderPlus className="w-4 h-4" />
                Conectar Drive
              </button>
            ) : (
              <div className="w-full bg-emerald-600/10 border border-emerald-500/30 text-emerald-400 font-medium py-2.5 px-4 rounded-lg text-xs flex items-center justify-center gap-2">
                <ShieldCheck className="w-4 h-4 text-emerald-400 animate-pulse" />
                <span>Drive Conectado</span>
              </div>
            )}
            <p className="text-[10px] text-slate-500 text-center">
              {!user ? "Conecte sua conta corporativa do Google." : "Sua conta do Google Drive está ativa."}
            </p>
          </div>

          <div className="space-y-2">
            <button
              onClick={triggerDemoSync}
              disabled={syncing}
              className="w-full bg-amber-600 hover:bg-amber-500 text-white font-medium py-2.5 px-4 rounded-lg text-xs transition-all flex items-center justify-center gap-2 disabled:opacity-50 shadow-[0_0_12px_rgba(245,158,11,0.35)]"
            >
              <Database className="w-4 h-4" />
              Carregar Banco Demo
            </button>
            <p className="text-[10px] text-slate-500 text-center">
              Instancia os robôs de demonstração e calcula seus embeddings.
            </p>
          </div>

          <div className="pt-2">
            <button
              onClick={triggerReset}
              disabled={syncing || (fileCount === 0 && chunkCount === 0)}
              className="w-full bg-[#05070A] hover:bg-rose-950 border border-white/10 hover:border-rose-900 text-slate-400 hover:text-rose-200 py-2 px-4 rounded-lg text-xs transition-colors flex items-center justify-center gap-1.5 disabled:opacity-30 disabled:hover:bg-[#05070A] disabled:hover:text-slate-400"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Limpar Banco de Vetores
            </button>
          </div>
        </div>

        {/* Integração do Google Drive à Direita (2 colunas) */}
        <div className="bg-[#080B12] border border-white/5 rounded-xl p-5 space-y-4 md:col-span-2">
          <h3 className="font-bold text-slate-200 text-xs uppercase tracking-wider flex items-center justify-between pb-2 border-b border-white/5">
            <span className="flex items-center gap-2">
              <FolderPlus className="w-4 h-4 text-emerald-400" />
              Conexão Google Drive Corporativo
            </span>
            {user && (
              <span className="text-[10px] text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20 font-mono uppercase">
                Conectado
              </span>
            )}
          </h3>

          {!user ? (
            <div className="py-8 text-center space-y-4">
              <p className="text-xs text-slate-400 max-w-sm mx-auto leading-relaxed">
                Conecte-se com sua conta corporativa para indexar arquivos PDF diretamente de uma pasta compartilhada ou do seu drive.
              </p>
              
              <button
                onClick={onLoginWithGoogle}
                className="gsi-material-button mx-auto"
                id="gsi_button"
              >
                <div className="gsi-material-button-state"></div>
                <div className="gsi-material-button-content-wrapper">
                  <div className="gsi-material-button-icon">
                    <svg version="1.1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" style={{ display: 'block' }}>
                      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"></path>
                      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"></path>
                      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"></path>
                      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"></path>
                      <path fill="none" d="M0 0h48v48H0z"></path>
                    </svg>
                  </div>
                  <span className="gsi-material-button-contents font-sans">Conectar ao Google Drive</span>
                </div>
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Info Usuário */}
              <div className="flex items-center justify-between p-3 bg-[#05070A] rounded-lg border border-white/5">
                <div className="flex items-center gap-3">
                  <img
                    src={user.photoURL || "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=100&auto=format&fit=crop&q=80"}
                    alt="Foto Perfil"
                    referrerPolicy="no-referrer"
                    className="w-10 h-10 rounded-full border border-white/10"
                  />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-200 truncate">{user.displayName}</p>
                    <p className="text-xs text-slate-500 truncate">{user.email}</p>
                  </div>
                </div>
                <button
                  onClick={onLogout}
                  className="text-xs text-slate-400 hover:text-slate-200 underline"
                >
                  Sair
                </button>
              </div>

              {/* Campo de link/id da pasta raiz do drive */}
              <div className="space-y-2 bg-[#05070A]/50 p-4 rounded-lg border border-white/5">
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider">
                  Link ou ID da Pasta Raiz do Google Drive:
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={inputFolderLink}
                    onChange={(e) => {
                      const val = e.target.value;
                      setInputFolderLink(val);
                      const id = extractFolderId(val);
                      setSelectedFolderId(id);
                      if (id) {
                        resolveFolderName(id);
                      } else {
                        setSelectedFolderName("");
                      }
                    }}
                    placeholder="Cole aqui o Link ou o ID da Pasta Raiz do Google Drive que contém os seus clientes"
                    className="flex-1 bg-[#020305] text-xs text-slate-200 border border-white/10 rounded-lg px-3 py-2.5 focus:outline-none focus:border-blue-500 transition-colors placeholder:text-slate-600"
                  />
                  {selectedFolderId && (
                    <button
                      type="button"
                      onClick={() => resolveFolderName(selectedFolderId)}
                      disabled={loadingFolderName}
                      className="bg-[#1B60BC]/10 hover:bg-[#1B60BC]/20 border border-[#1B60BC]/20 text-[#1B60BC] text-xs font-semibold px-3 py-2 rounded-lg transition-colors flex items-center justify-center gap-1.5 disabled:opacity-50 cursor-pointer"
                    >
                      {loadingFolderName ? (
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        "Validar"
                      )}
                    </button>
                  )}
                </div>
                <p className="text-[10px] text-slate-500 leading-relaxed">
                  Dica: O ID é a última parte do endereço da pasta no Google Drive (ex: <code className="bg-white/5 px-1 py-0.5 rounded text-slate-400">1A_B-C_D-E...</code>) ou cole o link completo diretamente.
                </p>
              </div>

              {/* Seletor de Pasta do Drive */}
              <div className="space-y-2 bg-[#05070A]/50 p-4 rounded-lg border border-white/5">
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider">
                  Selecione a Pasta Raiz de PDDs:
                </label>
                
                {/* Navegação */}
                <div className="flex items-center justify-between bg-[#080B12] p-2.5 rounded-lg border border-white/5">
                  <div className="flex items-center gap-1.5 overflow-x-auto min-w-0 pr-2">
                    <Folder className="w-4 h-4 text-amber-500 flex-shrink-0" />
                    <span className="text-xs font-semibold text-slate-300 truncate">
                      {navHistory[navHistory.length - 1].name}
                    </span>
                  </div>
                  {navHistory.length > 1 && (
                    <button
                      onClick={handleGoBack}
                      className="text-xs text-blue-400 hover:text-blue-300 font-semibold"
                    >
                      Voltar
                    </button>
                  )}
                </div>

                {/* Lista de subpastas */}
                <div className="border border-white/5 rounded-lg bg-[#05070A] max-h-40 overflow-y-auto p-1 text-xs">
                  {loadingFolders ? (
                    <div className="text-center py-6 text-slate-500 flex items-center justify-center gap-2">
                      <RefreshCw className="w-3.5 h-3.5 animate-spin text-blue-500" />
                      <span>Buscando subpastas do Drive...</span>
                    </div>
                  ) : folders.length === 0 ? (
                    <div className="text-center py-6 text-slate-500">
                      Nenhuma subpasta encontrada aqui.
                    </div>
                  ) : (
                    folders.map(f => (
                      <div
                        key={f.id}
                        onClick={() => handleFolderClick(f)}
                        className="flex items-center gap-2 p-2 hover:bg-white/5 rounded cursor-pointer text-slate-300 hover:text-white transition-colors"
                      >
                        <Folder className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
                        <span className="truncate">{f.name}</span>
                        <ArrowRight className="w-3 h-3 text-slate-600 ml-auto" />
                      </div>
                    ))
                  )}
                </div>

                {/* Pasta Escolhida */}
                {selectedFolderId ? (
                  <div className="bg-emerald-500/10 text-emerald-400 p-2.5 rounded-lg border border-emerald-500/20 text-xs flex items-center justify-between shadow-[0_0_12px_rgba(16,185,129,0.15)]">
                    <div>
                      <p className="font-semibold">Pasta Raiz Escolhida:</p>
                      <p className="font-mono text-[10px] text-slate-400 truncate max-w-md">{selectedFolderName} ({selectedFolderId})</p>
                    </div>
                    <button
                      onClick={triggerRealSync}
                      disabled={syncing}
                      className="bg-emerald-600 hover:bg-emerald-500 text-white font-semibold py-1.5 px-3 rounded text-xs transition-colors disabled:opacity-50 flex items-center gap-1 shadow-[0_0_10px_rgba(16,185,129,0.3)]"
                    >
                      <Play className="w-3 h-3" />
                      Sincronizar
                    </button>
                  </div>
                ) : (
                  <div className="bg-[#080B12] p-3 rounded-lg border border-white/5 text-xs text-slate-400 flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0" />
                    <span>Navegue nas pastas acima e selecione aquela que serve como Banco de Dados de PDDs.</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Terminal de Logs em tempo real */}
      <div className="bg-[#05070A] border border-white/5 rounded-xl overflow-hidden shadow-2xl">
        <div className="bg-[#080B12] px-4 py-2 border-b border-white/5 flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-400 font-mono">
            <Terminal className="w-4 h-4 text-blue-500" />
            <span>CONSOLE DE INDEXAÇÃO E SINCRONIZAÇÃO</span>
          </div>
          {syncing && (
            <span className="flex items-center gap-1.5 text-[10px] font-mono text-amber-400 animate-pulse uppercase">
              <RefreshCw className="w-3 h-3 animate-spin" />
              Processando RAG...
            </span>
          )}
        </div>
        
        <div className="p-4 h-56 overflow-y-auto font-mono text-xs text-emerald-400 space-y-1.5 bg-[#020305] custom-scrollbar leading-relaxed">
          {logs.length === 0 ? (
            <div className="text-slate-600 italic">
              [SISTEMA] Pronto para ação. Aguardando gatilho de sincronização para exibir logs detalhados...
            </div>
          ) : (
            logs.map((log, i) => {
              let colorClass = "text-emerald-400";
              if (log.startsWith("[ERRO]")) colorClass = "text-rose-400 font-bold";
              if (log.startsWith("[SISTEMA]")) colorClass = "text-blue-400 font-semibold";
              if (log.includes("->")) colorClass = "text-sky-300";
              
              return (
                <div key={i} className={colorClass}>
                  {log}
                </div>
              );
            })
          )}
          <div ref={terminalEndRef} />
        </div>
      </div>

      {/* Alerta de Status */}
      {statusMessage && (
        <div className="bg-[#080B12] text-slate-300 p-3.5 rounded-lg border border-white/10 text-xs text-center flex items-center justify-between">
          <span>{statusMessage}</span>
          <button onClick={() => setStatusMessage(null)} className="text-[10px] text-slate-500 hover:text-slate-300">
            Fechar
          </button>
        </div>
      )}
    </div>
  );
}
