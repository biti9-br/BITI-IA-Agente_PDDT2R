import React, { useState, useEffect } from "react";
import { Folder, Cpu, FileText, Search, Database, RefreshCw, Layers, Eye, EyeOff } from "lucide-react";
import { ClientGroup, PDDDocument } from "../types";

interface SidebarProps {
  clientGroups: ClientGroup[];
  selectedClientId: string;
  selectedRobotId: string;
  onSelectFilter: (clientId: string, robotId: string) => void;
  onResetFilters: () => void;
  fileCount: number;
  chunkCount: number;
  mode: "real" | "demo";
  loading: boolean;
  onRefresh: () => void;
  activeTab?: string;
  mobileOpen?: boolean;
  onCloseMobile?: () => void;
}

export default function Sidebar({
  clientGroups,
  selectedClientId,
  selectedRobotId,
  onSelectFilter,
  onResetFilters,
  fileCount,
  chunkCount,
  mode,
  loading,
  onRefresh,
  activeTab = "chat",
  mobileOpen = false,
  onCloseMobile
}: SidebarProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [showListInChat, setShowListInChat] = useState(false);
  const [expandedClients, setExpandedClients] = useState<Record<string, boolean>>({
    "demo_client_Cliente_A_(Banco_Global)": true,
    "demo_client_Cliente_B_(Varejo_Total)": true
  });
  const [expandedRobots, setExpandedRobots] = useState<Record<string, boolean>>({});

  // Reset show list state when switching tabs
  useEffect(() => {
    if (activeTab === "chat") {
      setShowListInChat(false);
    }
  }, [activeTab]);

  const toggleClient = (id: string) => {
    setExpandedClients(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const toggleRobot = (id: string) => {
    setExpandedRobots(prev => ({ ...prev, [id]: !prev[id] }));
  };

  // Filtra os grupos de clientes com base no texto de busca
  const filteredGroups = clientGroups.map(client => {
    const matchedRobots = client.robots.map(robot => {
      const matchedDocs = robot.documents.filter(doc =>
        doc.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        robot.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        client.name.toLowerCase().includes(searchQuery.toLowerCase())
      );
      
      const isRobotMatch = robot.name.toLowerCase().includes(searchQuery.toLowerCase());
      
      if (isRobotMatch || matchedDocs.length > 0) {
        return {
          ...robot,
          documents: matchedDocs.length > 0 ? matchedDocs : robot.documents
        };
      }
      return null;
    }).filter(Boolean) as any[];

    const isClientMatch = client.name.toLowerCase().includes(searchQuery.toLowerCase());

    if (isClientMatch || matchedRobots.length > 0) {
      return {
        ...client,
        robots: matchedRobots.length > 0 ? matchedRobots : client.robots
      };
    }
    return null;
  }).filter(Boolean) as ClientGroup[];

  const isFilterActive = selectedClientId || selectedRobotId;

  return (
    <>
      {/* Mobile Backdrop */}
      {mobileOpen && (
        <div 
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-30 lg:hidden"
          onClick={onCloseMobile}
        />
      )}
      
      <div 
        id="sidebar_container" 
        className={`fixed inset-y-0 left-0 z-40 w-80 bg-[var(--cor-superficie)] border-r border-[var(--cor-borda)] flex flex-col h-full text-[var(--cor-texto)] transition-transform duration-300 transform lg:translate-x-0 lg:static ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        {/* Botão de Fechar no Mobile se necessário */}
        {mobileOpen && onCloseMobile && (
          <div className="p-4 border-b border-[var(--cor-borda)] flex items-center justify-between bg-[var(--cor-card-fundo)] lg:hidden">
            <span className="text-xs font-semibold text-[var(--cor-texto)]">Filtros de busca</span>
            <button
              onClick={onCloseMobile}
              className="p-1 hover:bg-[var(--cor-hover)] rounded-md text-[var(--cor-texto-secundario)] hover:text-[var(--cor-texto)] transition-colors text-xs font-bold"
            >
              ✕
            </button>
          </div>
        )}

      {activeTab === "chat" && !showListInChat ? (
        <div className="flex-1 p-6 text-center flex flex-col justify-center items-center space-y-4">
          <div className="p-3 bg-[var(--cor-primaria-clara)] rounded-full text-[var(--cor-primaria)]">
            <Layers className="w-6 h-6" />
          </div>
          <div className="space-y-1.5">
            <h4 className="text-xs font-semibold text-[var(--cor-texto)]">Interface Focada</h4>
            <p className="text-xs text-[var(--cor-texto-secundario)] leading-relaxed max-w-[200px]">
              Ocultamos a busca e a lista de robôs para garantir 100% de foco na conversa do Chat Central.
            </p>
          </div>
          <button
            onClick={() => setShowListInChat(true)}
            className="flex items-center gap-1.5 bg-[var(--cor-primaria-clara)] hover:bg-[var(--cor-hover)] text-[var(--cor-primaria)] border border-[var(--cor-borda-primaria)] text-xs font-semibold py-1.5 px-3.5 rounded-lg transition-all cursor-pointer shadow-2xs"
          >
            <Eye className="w-3.5 h-3.5" />
            <span>Exibir Filtros</span>
          </button>
        </div>
      ) : (
        <>
          {activeTab === "chat" && (
            <div className="p-2.5 bg-[var(--cor-primaria-clara)] border-b border-[var(--cor-borda-primaria)] flex items-center justify-between">
              <span className="text-xs font-semibold text-[var(--cor-primaria)] pl-1 flex items-center gap-1">
                <Layers className="w-3 h-3" />
                Modo Filtros Ativo
              </span>
              <button
                onClick={() => setShowListInChat(false)}
                className="flex items-center gap-1 text-xs text-[var(--cor-texto-secundario)] hover:text-[var(--cor-texto)] font-medium bg-[var(--cor-card-fundo)] px-2 py-1 rounded border border-[var(--cor-borda-primaria)] transition-colors cursor-pointer"
              >
                <EyeOff className="w-3.5 h-3.5" />
                <span>Ocultar</span>
              </button>
            </div>
          )}

          {/* Busca */}
          <div className="p-3 border-b border-[var(--cor-borda)] bg-[var(--cor-card-fundo)]">
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 w-4 h-4 text-[var(--cor-texto-secundario)]" />
          <input
            type="text"
            placeholder="Buscar PDD ou robô..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-[var(--cor-superficie)] border border-[var(--cor-borda)] rounded-lg py-2 pl-9 pr-4 text-xs text-[var(--cor-texto)] placeholder-[var(--cor-texto-secundario)] focus:outline-none focus:border-[var(--cor-primaria)] focus:bg-[var(--cor-card-fundo)] transition-colors"
          />
        </div>
      </div>

      {/* Árvore de Clientes e Robôs */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1.5 custom-scrollbar bg-[var(--cor-superficie)]">
        <div className="px-2 py-1 text-xs font-semibold text-[var(--cor-texto-secundario)] flex justify-between items-center">
          <span>Clientes & Robôs</span>
          {isFilterActive && (
            <button 
              onClick={onResetFilters} 
              className="text-xs text-[var(--cor-primaria)] hover:text-[var(--cor-texto)] transition-colors font-medium bg-[var(--cor-primaria-clara)] px-1.5 py-0.5 rounded border border-[var(--cor-borda-primaria)]"
            >
              Limpar filtros
            </button>
          )}
        </div>

        {filteredGroups.length === 0 ? (
          <div className="text-center py-8 text-xs text-[var(--cor-texto-secundario)]">
            {searchQuery ? "Nenhum resultado encontrado." : "Sincronize arquivos para ver os clientes."}
          </div>
        ) : (
          filteredGroups.map(client => {
            const isClientExpanded = !!expandedClients[client.id];
            const isClientSelected = selectedClientId === client.id && !selectedRobotId;

            return (
              <div key={client.id} className="space-y-0.5">
                {/* Cabeçalho do Cliente */}
                <div 
                  onClick={() => {
                    onSelectFilter(client.id, "");
                    toggleClient(client.id);
                  }}
                  className={`flex items-center justify-between p-2 rounded-lg cursor-pointer transition-colors group ${
                    isClientSelected 
                      ? "bg-[var(--cor-primaria-clara)] text-[var(--cor-primaria)] font-medium border border-[var(--cor-borda-primaria)]" 
                      : selectedClientId === client.id 
                        ? "text-[var(--cor-primaria)] bg-[var(--cor-primaria-clara)]/50"
                        : "hover:bg-[var(--cor-hover)] text-[var(--cor-texto)]"
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <Folder className={`w-4 h-4 flex-shrink-0 ${isClientSelected ? "text-[var(--cor-primaria)]" : "text-[var(--cor-texto-secundario)]"}`} />
                    <span className="truncate text-xs font-medium">{client.name}</span>
                  </div>
                  <span className="text-[10px] font-semibold bg-[var(--cor-card-fundo)] border border-[var(--cor-borda)] text-[var(--cor-texto-secundario)] px-1.5 py-0.5 rounded-full font-sans">
                    {client.robots.length}
                  </span>
                </div>

                {/* Sublista de Robôs */}
                {isClientExpanded && (
                  <div className="pl-4 border-l border-[var(--cor-borda)] ml-4 space-y-0.5 mt-0.5">
                    {client.robots.map(robot => {
                      const isRobotExpanded = !!expandedRobots[robot.id];
                      const isRobotSelected = selectedRobotId === robot.id;

                      return (
                        <div key={robot.id} className="space-y-0.5">
                          {/* Cabeçalho do Robô */}
                          <div
                            onClick={() => {
                              onSelectFilter(client.id, robot.id);
                              toggleRobot(robot.id);
                            }}
                            className={`flex items-center justify-between p-1.5 rounded-md cursor-pointer transition-colors group text-xs ${
                              isRobotSelected 
                                ? "bg-[var(--cor-primaria-clara)] text-[var(--cor-primaria)] font-medium border border-[var(--cor-borda-primaria)]" 
                                : "hover:bg-[var(--cor-hover)] text-[var(--cor-texto-secundario)] hover:text-[var(--cor-texto)]"
                            }`}
                          >
                            <div className="flex items-center gap-1.5 min-w-0">
                              <Cpu className={`w-3.5 h-3.5 flex-shrink-0 ${isRobotSelected ? "text-[var(--cor-primaria)]" : "text-[var(--cor-texto-secundario)]"}`} />
                              <span className="truncate">{robot.name}</span>
                            </div>
                            <span className="text-[9px] bg-[var(--cor-card-fundo)] border border-[var(--cor-borda)] text-[var(--cor-texto-secundario)] px-1 rounded-full font-sans">
                              {robot.documents.length}
                            </span>
                          </div>

                          {/* Arquivos do Robô */}
                          {(isRobotExpanded || isRobotSelected) && (
                            <div className="pl-3 border-l border-[var(--cor-borda)] ml-3 space-y-0.5 mt-0.5">
                              {robot.documents.map(doc => (
                                <div
                                  key={doc.id}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onSelectFilter(client.id, robot.id);
                                  }}
                                  className="flex items-center gap-1.5 p-1 rounded hover:bg-[var(--cor-hover)] text-[var(--cor-texto-secundario)] hover:text-[var(--cor-texto)] cursor-pointer text-xs transition-colors"
                                  title={`Modificado: ${new Date(doc.modifiedTime).toLocaleDateString()}`}
                                >
                                  <FileText className="w-3 h-3 text-[var(--cor-texto-secundario)] flex-shrink-0" />
                                  <span className="truncate flex-1">{doc.name}</span>
                                  {doc.chunkCount && (
                                    <span className="text-[9px] text-[var(--cor-primaria)] bg-[var(--cor-primaria-clara)] border border-[var(--cor-borda-primaria)] px-1 rounded font-medium">
                                      {doc.chunkCount}f
                                    </span>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </>
  )}

      {/* Footer corporativo sutil */}
      <div className="p-3 bg-[var(--cor-card-fundo)] border-t border-[var(--cor-borda)] text-center flex items-center justify-center gap-1.5 text-xs text-[var(--cor-texto-secundario)]">
        <Layers className="w-3 h-3 text-[var(--cor-primaria)]" />
        <span>biti9 RAG Engine</span>
      </div>
    </div>
  </>
  );
}
