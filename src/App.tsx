import React, { useState, useEffect, useRef } from "react";
import { Database, User, LogOut, Sparkles, Plus, History, ChevronDown, Sun, Moon, ShieldCheck } from "lucide-react";
import ChatPanel from "./components/ChatPanel";
import SourcesPanel from "./components/SourcesPanel";
import TelaDeLogin from "./components/TelaDeLogin";
import AdminDocumentTypesModal from "./components/AdminDocumentTypesModal";
import { useAuth } from "./hooks/useAuth";
import { useDbStatus } from "./hooks/useDbStatus";
import { apiFetch } from "./services/api";
import { useTheme } from "./hooks/useTheme";

export default function App() {
  const { usuario, carregandoAuth, userEmail, authError, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();

  // Estados de layout e menu
  const [showSources, setShowSources] = useState(true);
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const [triggerNewSession, setTriggerNewSession] = useState(0);
  const [triggerOpenHistory, setTriggerOpenHistory] = useState(0);
  const [isAdmin, setIsAdmin] = useState(false);
  const [showAdminModal, setShowAdminModal] = useState(false);
  const headerMenuRef = useRef<HTMLDivElement>(null);

  // Filtros de seleção rápida
  const [selectedClientId, setSelectedClientId] = useState("");
  const [selectedRobotId, setSelectedRobotId] = useState("");

  // Hook centralizado para fontes e banco de vetores
  const {
    dbStatus,
    loading,
    activeSessionId,
    selectedFileIds,
    setSelectedFileIds,
    loadDbStatus,
    handleSessionChange,
    handleToggleFile,
    handleToggleAll
  } = useDbStatus(userEmail);

  // Resetar selectedFileIds ao iniciar uma nova conversa
  useEffect(() => {
    if (triggerNewSession > 0) {
      setSelectedFileIds([]);
    }
  }, [triggerNewSession, setSelectedFileIds]);

  // Checar se o usuário é administrador (settings/admins)
  useEffect(() => {
    if (userEmail) {
      apiFetch("/api/settings/admins/check")
        .then(res => res.json())
        .then(data => {
          setIsAdmin(Boolean(data && data.isAdmin));
        })
        .catch(() => setIsAdmin(false));
    } else {
      setIsAdmin(false);
    }
  }, [userEmail]);

  // Fecha o menu suspenso ao clicar fora
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (headerMenuRef.current && !headerMenuRef.current.contains(e.target as Node)) {
        setHeaderMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleResetFilters = () => {
    setSelectedClientId("");
    setSelectedRobotId("");
  };

  // 1. Carregando autenticação
  if (carregandoAuth) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-[var(--cor-fundo)] text-[var(--cor-texto)]">
        <div className="w-10 h-10 border-2 border-[var(--cor-primaria)] border-t-transparent rounded-full animate-spin mb-4" />
        <p className="text-xs text-[var(--cor-texto-secundario)] font-medium">Carregando...</p>
      </div>
    );
  }

  // 2. Não autenticado -> Tela de Login
  if (!usuario) {
    return <TelaDeLogin initialError={authError} />;
  }

  // 3. Aplicação principal autenticada
  return (
    <div className="flex flex-col h-screen w-screen bg-[var(--cor-fundo)] font-sans overflow-hidden text-[var(--cor-texto)]">
      
      {/* Top Header Barra de Navegação: Apenas Logo e Menu do Usuário */}
      <header className="bg-[var(--cor-header-fundo)] border-b border-[var(--cor-header-borda)] flex-shrink-0 h-16 flex items-center justify-between px-4 lg:px-6 z-20 shadow-xs transition-colors duration-200">
        <div className="flex items-center gap-3.5">
          <div className="flex items-center py-1">
            <img
              src="https://www.biti9.com.br/wp-content/uploads/2024/07/LOGO-BRANCA-1024x619.png"
              alt="biti9"
              referrerPolicy="no-referrer"
              className="h-8 md:h-9 w-auto object-contain select-none"
            />
          </div>
        </div>

        {/* Controles da Direita: Alternância de Tema e Menu do Usuário */}
        <div className="flex items-center gap-2 sm:gap-3">
          {/* Botão de Alternar Versão Clara / Escura */}
          <button
            onClick={toggleTheme}
            className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/15 flex items-center justify-center text-white transition-all cursor-pointer shadow-xs"
            title={theme === "dark" ? "Alternar para Versão Clara" : "Alternar para Versão Escura"}
            aria-label="Alternar tema"
          >
            {theme === "dark" ? (
              <Sun className="w-4 h-4 text-white" />
            ) : (
              <Moon className="w-4 h-4 text-white" />
            )}
          </button>

          {/* Menu Unificado do Usuário */}
          <div className="relative" ref={headerMenuRef}>
            <button
              onClick={() => setHeaderMenuOpen(prev => !prev)}
              className="flex items-center gap-2.5 py-1.5 px-3 rounded-full bg-white/10 hover:bg-white/15 text-white transition-all cursor-pointer shadow-xs"
              title="Menu do Usuário"
            >
              <div className="w-7 h-7 rounded-full bg-white/20 flex items-center justify-center text-white font-semibold text-xs flex-shrink-0">
                {usuario.email ? usuario.email.charAt(0).toUpperCase() : <User className="w-3.5 h-3.5" />}
              </div>
              <span className="text-xs font-medium text-white max-w-[170px] sm:max-w-[220px] truncate" title={usuario.email || ""}>
                {usuario.email}
              </span>
              <ChevronDown className={`w-3.5 h-3.5 text-white/70 transition-transform ${headerMenuOpen ? "rotate-180" : ""}`} />
            </button>

            {headerMenuOpen && (
              <div className="absolute right-0 top-full mt-2 w-64 bg-[var(--cor-card-fundo)] border border-[var(--cor-borda)] rounded-2xl shadow-xl py-2 z-50 animate-fade-in text-[var(--cor-texto)]">
                {/* Informações do Usuário e Badge do Painel Consolidado */}
                <div className="px-4 py-2.5 border-b border-[var(--cor-borda)] space-y-1.5">
                  <p className="text-xs font-semibold text-[var(--cor-texto)] truncate" title={usuario.email || ""}>
                    {usuario.email}
                  </p>
                  <div className="inline-flex items-center gap-1.5 text-[11px] font-medium text-[var(--cor-primaria)] bg-[var(--cor-primaria-clara)] px-2.5 py-0.5 rounded-full">
                    <Sparkles className="w-3 h-3 text-[var(--cor-primaria)]" />
                    <span>Painel Integrado Centralizado</span>
                  </div>
                </div>

                {/* Ações Rápidas */}
                <div className="py-1">
                  <button
                    onClick={() => {
                      setSelectedFileIds([]);
                      setTriggerNewSession(c => c + 1);
                      setHeaderMenuOpen(false);
                    }}
                    className="w-full flex items-center gap-2.5 px-4 py-2 text-xs text-[var(--cor-texto)] hover:bg-[var(--cor-superficie)] transition-colors cursor-pointer text-left"
                  >
                    <Plus className="w-3.5 h-3.5 text-[var(--cor-primaria)]" />
                    <span>Nova conversa</span>
                  </button>

                  <button
                    onClick={() => {
                      setTriggerOpenHistory(c => c + 1);
                      setHeaderMenuOpen(false);
                    }}
                    className="w-full flex items-center gap-2.5 px-4 py-2 text-xs text-[var(--cor-texto)] hover:bg-[var(--cor-superficie)] transition-colors cursor-pointer text-left"
                  >
                    <History className="w-3.5 h-3.5 text-amber-500" />
                    <span>Histórico de conversas</span>
                  </button>

                  <button
                    onClick={() => {
                      setShowSources(prev => !prev);
                      setHeaderMenuOpen(false);
                    }}
                    className="w-full flex items-center gap-2.5 px-4 py-2 text-xs text-[var(--cor-texto)] hover:bg-[var(--cor-superficie)] transition-colors cursor-pointer text-left"
                  >
                    <Database className="w-3.5 h-3.5 text-[var(--cor-primaria)]" />
                    <span>{showSources ? "Ocultar fontes" : "Mostrar fontes"}</span>
                  </button>

                  {/* Alternar Tema no Menu */}
                  <button
                    onClick={() => {
                      toggleTheme();
                    }}
                    className="w-full flex items-center justify-between px-4 py-2 text-xs text-[var(--cor-texto)] hover:bg-[var(--cor-superficie)] transition-colors cursor-pointer text-left"
                  >
                    <div className="flex items-center gap-2.5">
                      {theme === "dark" ? (
                        <Sun className="w-3.5 h-3.5 text-amber-400" />
                      ) : (
                        <Moon className="w-3.5 h-3.5 text-sky-600" />
                      )}
                      <span>{theme === "dark" ? "Versão Clara" : "Versão Escura"}</span>
                    </div>
                    <span className="text-[10px] text-[var(--cor-primaria)] font-semibold px-2 py-0.5 rounded-full bg-[var(--cor-primaria-clara)]">
                      {theme === "dark" ? "Escuro" : "Claro"}
                    </span>
                  </button>

                  {/* Item de Administração - Visível apenas para e-mails em settings/admins */}
                  {isAdmin && (
                    <>
                      <div className="my-1 border-t border-[var(--cor-borda)]" />
                      <div className="px-4 py-1 text-[10px] font-semibold text-[var(--cor-texto-secundario)] uppercase tracking-wider">
                        Administração
                      </div>
                      <button
                        onClick={() => {
                          setHeaderMenuOpen(false);
                          setShowAdminModal(true);
                        }}
                        className="w-full flex items-center gap-2.5 px-4 py-2 text-xs text-indigo-500 dark:text-indigo-400 hover:bg-[var(--cor-superficie)] transition-colors cursor-pointer text-left font-medium"
                      >
                        <ShieldCheck className="w-3.5 h-3.5 flex-shrink-0" />
                        <span>Tipos de documento</span>
                      </button>
                    </>
                  )}
                </div>

                <div className="my-1 border-t border-[var(--cor-borda)]" />

                {/* Botão Sair */}
                <div className="pt-1">
                  <button
                    onClick={() => {
                      setHeaderMenuOpen(false);
                      logout();
                    }}
                    className="w-full flex items-center gap-2.5 px-4 py-2 text-xs text-rose-600 hover:bg-rose-500/10 transition-colors cursor-pointer text-left font-medium"
                  >
                    <LogOut className="w-3.5 h-3.5" />
                    <span>Sair da conta</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

      </header>

      {/* Área Principal de Conteúdo */}
      <div className="flex-1 flex flex-col md:flex-row min-h-0 overflow-hidden">
        {/* Esquerda: Painel de Fontes de Consulta (Sidebar) */}
        {showSources && (
          <SourcesPanel
            clientGroups={dbStatus.clientGroups}
            selectedFileIds={selectedFileIds}
            onToggleFile={handleToggleFile}
            onToggleAll={handleToggleAll}
            onRefresh={() => loadDbStatus(activeSessionId)}
            userEmail={userEmail}
            activeSessionId={activeSessionId}
            loading={loading}
          />
        )}

        {/* Centro/Direita: Chat de Conversa */}
        <main className="flex-1 flex flex-col min-h-0 bg-[var(--cor-fundo)]">
          <ChatPanel
            selectedClientId={selectedClientId}
            selectedRobotId={selectedRobotId}
            clientGroups={dbStatus.clientGroups}
            onResetFilters={handleResetFilters}
            userEmail={userEmail}
            token=""
            onRefresh={() => loadDbStatus(activeSessionId)}
            selectedFileIds={selectedFileIds}
            activeSessionId={activeSessionId}
            onSessionChange={handleSessionChange}
            onNewSession={() => setSelectedFileIds([])}
            showSources={showSources}
            onToggleSources={() => setShowSources(prev => !prev)}
            triggerNewSession={triggerNewSession}
            triggerOpenHistory={triggerOpenHistory}
            userId={usuario?.uid}
          />
        </main>
      </div>

      {/* Modal de Administração de Tipos de Documentos */}
      {isAdmin && (
        <AdminDocumentTypesModal
          isOpen={showAdminModal}
          onClose={() => setShowAdminModal(false)}
          userEmail={userEmail}
          onTypesUpdated={() => {
            loadDbStatus(activeSessionId);
          }}
        />
      )}
    </div>
  );
}
