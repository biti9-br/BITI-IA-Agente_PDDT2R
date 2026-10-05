> [Imagem não processada]

<table><tbody><tr><td><p><img src="about:blank" alt="Esta imagem contém o logotipo da empresa **Bitis** com o slogan **Business IT Innovation**. Não há um diagrama de fluxo ou documento de processo nesta imagem. Trata-se exclusivamente de uma marca corporativa com o nome e o slogan da empresa. **Transcrição do texto visível:** 1.  **&quot;Biti&quot;** (em letras pretas em negrito) 2.  **&quot;is&quot;** (estilizado com efeito de gradiente azul em um formato geométrico) 3.  **&quot;Business IT Innovation&quot;** (texto em fonte menor, cinza escuro, posicionado abaixo do nome principal). **Descrição do conteúdo:** Como mencionado, a imagem não apresenta fluxogramas, etapas, decisões ou caminhos. É apenas a identidade visual (logotipo) da empresa Bitis."></p></td><td><p>Process Definition Document</p></td></tr></tbody></table>

**Distribuidora Aurora Ltda.**

**Conciliação de Pagamentos a Fornecedores**

_Documento fictício para homologação do Agente PDD/T2R. Empresas, pessoas, sistemas e valores são ilustrativos._

  
  
  
  
  
  
  
  
  
  
  
**Histórico de Revisões**

<table><tbody><tr><td><p>Versão</p></td><td><p>Data</p></td><td><p>Autor(es)</p></td><td><p>Descrição</p></td></tr><tr><td><p>1.0</p></td><td><p>10/03/2026</p></td><td><p>Carla Menezes</p></td><td><p>Versão inicial do PDD.</p></td></tr><tr><td><p>1.1</p></td><td><p>02/05/2026</p></td><td><p>Diego Furtado</p></td><td><p>Inclusão da exceção EX-04 (fornecedor com CNPJ baixado na Receita Federal).</p></td></tr><tr><td><p>1.2</p></td><td><p>18/08/2026</p></td><td><p>Carla Menezes</p></td><td><p>Volume mensal atualizado de 1.800 para 2.400 notas fiscais e inclusão da execução das 13h30.</p></td></tr></tbody></table>

**Histórico de Aprovação**

<table><tbody><tr><td><p>Data do Envio</p></td><td><p>Data de Aprovação</p></td><td><p>Aprovador</p></td><td><p>Versão Aprovada</p></td></tr><tr><td><p>19/08/2026</p></td><td><p>20/08/2026</p></td><td><p>Roberto Lins (Coordenador Financeiro)</p></td><td><p>1.2</p></td></tr></tbody></table>

# Descrição do Processo

## 1.1 Introdução a alteração

<table><tbody><tr><td><p>Item</p></td><td><p>Descrição</p></td></tr><tr><td><p>Processo</p></td><td><p>Conciliação de Pagamentos a Fornecedores – robô RBT-FIN-07</p></td></tr><tr><td><p>Cliente / Área</p></td><td><p>Distribuidora Aurora Ltda. – Contas a Pagar (Diretoria Financeira)</p></td></tr><tr><td><p>Objetivo e escopo</p></td><td><p>Confrontar, duas vezes por dia útil, as notas fiscais de fornecedores em aberto no SAP S/4HANA com os pagamentos efetivados no Portal Banco Atlântico, registrados na planilha Controle_Pagamentos.xlsx.</p><p>Meta: reduzir o tempo diário de conciliação de 6 horas para 1 hora e 30 minutos e eliminar pagamentos em duplicidade.</p><p>Fora do escopo: fornecedores internacionais (moeda estrangeira), adiantamentos a fornecedores e pagamentos acima de R$ 250.000,00.</p></td></tr></tbody></table>

## 1.2 Contatos do Processo

O documento de especificações inclui requisitos concisos e completos do processo de negócios e é construído com base nos insumos fornecidos pelo keyuser do processo.

Espera-se que o keyuser do processo realize a análise e forneça a aprovação para precisão e conclusão das etapas, contexto, impacto e um conjunto de exceções de processo.

<table><tbody><tr><td><p>Cargo / Área</p></td><td><p>Nome</p></td><td><p>Organização</p></td><td><p>Observações</p></td></tr><tr><td><p>Key User / Aprovador</p></td><td><p>Carla Menezes</p></td><td><p>Distribuidora Aurora</p></td><td><p>Analista Financeiro Pleno</p></td></tr><tr><td></td><td></td><td></td><td></td></tr><tr><td><p>Sponsor</p></td><td><p>Roberto Lins</p></td><td><p>Distribuidora Aurora</p></td><td><p>Coordenador Financeiro</p></td></tr><tr><td></td><td></td><td></td><td></td></tr><tr><td><p>Desenvolvedor RPA</p></td><td><p>Diego Furtado</p></td><td><p>BITi9</p></td><td><p>Também responde pela sustentação do robô</p></td></tr><tr><td></td><td></td><td></td><td></td></tr><tr><td><p>Gerente de Projetos</p></td><td><p>Patrícia Alves</p></td><td><p>BITi9</p></td><td></td></tr><tr><td></td><td></td><td></td><td></td></tr><tr><td><p>Customer Success</p></td><td><p>Lucas Prado</p></td><td><p>BITi9</p></td><td></td></tr><tr><td></td><td></td><td></td><td></td></tr></tbody></table>

## 1.3 Mapa de Fluxo

### Fluxo SAE
> [Imagem: Esta é uma descrição detalhada do fluxograma apresentado na imagem.

### 1. Transcrição Literal do Texto *   **Título:** Mapa do Processo – Conciliação de Pagamentos a Fornecedores (RBT-FIN-07) *   **Caixa 1:** Início 07h30 e 13h30 (dias úteis) *   **Caixa 2:** Extrai partidas em aberto no SAP (transação FBL1N) *   **Caixa 3:** Lê a planilha Controle_Pagamentos (.xlsx) *   **Caixa 4:** Concilia NF x pagamento pelo CNPJ + Nº da NF *   **Losango (Decisão):** Diferença de valor ≤ R$ 0,05?     *   **Saída "Sim":** (Direita)     *   **Saída "Não":** (Esquerda) *   **Caixa 5 (Verde):** Status: CONCILIADO *   **Caixa 6 (Laranja):** Registra exceção EX-02 e envia ao analista *   **Caixa 7:** Arquiva comprovantes em \\FS01\Conciliacao\AAAA-MM *   **Caixa 8:** Envia o Relatório Diário de Conciliação por e-mail até 10h00 / 16h00 *   **Caixa 9:** Fim ---

### 2. Descrição do Fluxo O processo segue a ordem lógica abaixo: 1.  **Início:** O processo começa em dois horários fixos (07h30 e 13h30) em dias úteis. 2.  **Extração:** O sistema extrai as partidas em aberto do SAP através da transação FBL1N. 3.  **Leitura:** O processo lê o arquivo `.xlsx` chamado "Controle_Pagamentos". 4.  **Conciliação:** Ocorre a conciliação entre a Nota Fiscal (NF) e o pagamento, utilizando como chave o CNPJ e o número da NF. 5.  **Decisão:** Verifica-se se a diferença de valor é menor ou igual a R$ 0,05:     *   **Se a resposta for "Sim":** O status é definido como "CONCILIADO". Após isso, o processo segue para o arquivamento dos comprovantes no caminho `\\FS01\Conciliacao\AAAA-MM`.     *   **Se a resposta for "Não":** O processo registra a exceção "EX-02" e envia o caso para o analista. 6.  **Conclusão:** Após o arquivamento (no caminho "Sim") ou após o registro da exceção (no caminho "Não"), o fluxo converge para o envio do "Relatório Diário de Conciliação" por e-mail, que deve ocorrer até às 10h00 ou 16h00. 7.  **Fim:** O processo encerra após o envio do relatório por e-mail.]

## 1.4 Premissas do Processo

### Programas e Aplicações

A tabela abaixo lista todas as aplicações utilizadas durante o processo automatizado.

<table><tbody><tr><td><p>Nome do Sistema</p></td><td><p>Tipo</p></td><td><p>Ambiente</p></td><td><p>Observações</p></td></tr><tr><td><p>SAP S/4HANA</p></td><td><p>ERP</p></td><td><p>Produção</p></td><td><p>Transações FBL1N (consulta de partidas, somente leitura) e ZFI_CONC (gravação de status). Acesso liberado pela TI Cliente – Fernanda Rocha.</p></td></tr><tr><td></td></tr><tr><td><p>Portal Banco Atlântico</p></td><td><p>Web / Banco</p></td><td><p>Produção</p></td><td><p>Perfil Consulta de Pagamentos, liberado pela Tesouraria.</p></td></tr><tr><td></td></tr><tr><td><p>VPN FortiClient</p></td><td><p>Rede</p></td><td><p>Produção</p></td><td><p>Obrigatória durante toda a execução. Sem VPN o robô não é executado.</p></td></tr><tr><td></td></tr><tr><td><p>CyberArk</p></td><td><p>Cofre de senhas</p></td><td><p>Produção</p></td><td><p>Guarda a senha do usuário de serviço svc_rpa_fin07, que expira a cada 90 dias.</p></td></tr><tr><td></td></tr></tbody></table>

##

# Documentos e Arquivos Relacionados

A tabela abaixo lista todos os arquivos e documentos relacionados ao processo.

<table><tbody><tr><td><p>Documento</p></td><td><p>Tipo</p></td><td><p>Extensão</p></td><td><p>Link</p></td></tr><tr><td><p>Controle_Pagamentos.xlsx</p></td><td><p>Planilha de controle de pagamentos</p></td><td><p>XLSX</p></td><td><p>\\FS01\Financeiro</p></td></tr><tr><td></td><td></td><td></td><td></td></tr><tr><td><p>Relatório Diário de Conciliação</p></td><td><p>Relatório gerado pelo robô</p></td><td><p>XLSX</p></td><td><p>Enviado por e-mail</p></td></tr><tr><td></td><td></td><td></td><td></td></tr></tbody></table>

##

# Vídeos do Processo

A tabela abaixo lista todos os vídeos de mapeamento do processo.

<table><tbody><tr><td><p>Título</p></td><td><p>Link</p></td><td><p>Observações</p></td></tr><tr><td><p>Gravação de Reunião — Mapeamento de Processo</p></td><td><p>[A CONFIRMAR]</p></td><td><p>Reunião realizada em 12/08/2026, com duração de 48 minutos.</p></td></tr><tr><td></td></tr></tbody></table>

## 1.5 Responsabilidades

A tabela abaixo é preenchida de acordo com a matriz de responsabilidades RACI.

<table><tbody><tr><td><p>Atividade</p></td><td><p>BITi9</p></td><td><p>Área de Negócio</p></td><td><p>TI / Cliente</p></td></tr><tr><td><p>Executar a conciliação (robô)</p></td><td><p>R/A</p></td><td><p>I</p></td><td><p>C</p></td></tr><tr><td></td></tr><tr><td><p>Tratar exceções EX-01 e EX-02</p></td><td><p>I</p></td><td><p>R/A</p></td><td><p>-</p></td></tr><tr><td></td></tr><tr><td><p>Tratar exceções EX-03 e EX-04</p></td><td><p>C</p></td><td><p>R/A</p></td><td><p>I</p></td></tr><tr><td></td></tr><tr><td><p>Liberar e manter acessos (SAP, VPN, pasta)</p></td><td><p>C</p></td><td><p>I</p></td><td><p>R/A</p></td></tr><tr><td></td></tr><tr><td><p>Renovar a senha do usuário de serviço</p></td><td><p>R/A</p></td><td><p>-</p></td><td><p>C</p></td></tr><tr><td></td></tr></tbody></table>

Legenda: **R** – Responsável / **A** – Aprovador / **C** – Consultado / **I** – Informado

# Detalhamento da Alteração

#### 2.1 - Início da execução

<table><tbody><tr><td><p>[00:00]</p></td><td><p><strong>Ação: O robô inicia às 07h30 e às 13h30, somente em dias úteis. Em feriados municipais de São Paulo, não executa. Sistema: Orquestrador RPA</strong></p></td></tr></tbody></table>

###

# 2.2 - Conexão e acesso ao SAP

<table><tbody><tr><td><p>[03:10]</p></td><td><p><strong>Ação: Conecta à VPN e acessa o SAP com o usuário de serviço svc_rpa_fin07, cuja senha é obtida no CyberArk. Sistema: VPN FortiClient / CyberArk / SAP S/4HANA</strong></p></td></tr></tbody></table>

###

# 2.3 - Extração das partidas em aberto

<table><tbody><tr><td><p>[06:40]</p></td><td><p><strong>Ação: Na transação FBL1N, extrai as partidas de fornecedores em aberto com vencimento até a data atual. Sistema: SAP S/4HANA</strong></p></td></tr></tbody></table>

###

# 2.4 - Leitura da planilha de controle

<table><tbody><tr><td><p>[10:15]</p></td><td><p><strong>Ação: Abre a planilha Controle_Pagamentos.xlsx e lê a aba Pagamentos, que deve conter os campos:</strong></p><p>- &lt;CNPJ do fornecedor&gt; (Coluna B)</p><p>- &lt;Número da NF&gt; (Coluna C)</p><p>- &lt;Valor bruto&gt; (Coluna F)</p><p>- &lt;Data de vencimento&gt; (Coluna H)</p><p>- &lt;Forma de pagamento&gt; (Coluna J) – BOLETO, PIX ou TED</p><p>- &lt;Status do pagamento&gt; (Coluna K) – preenchido pelo robô</p><p>Sistema: Controle_Pagamentos.xlsx</p></td></tr></tbody></table>

###

# 2.5 - Conciliação

<table><tbody><tr><td><p>[14:30]</p></td><td><p><strong>Ação: Para cada nota, procura o pagamento correspondente pela combinação CNPJ do fornecedor + Número da NF. Sistema: SAP S/4HANA / Controle_Pagamentos.xlsx</strong></p></td></tr></tbody></table>

###

# 2.6 - Validação de valor

<table><tbody><tr><td><p>[18:05]</p></td><td><p><strong>Ação: Se a diferença entre o valor da nota e o valor pago for de até R$ 0,05, marca o status CONCILIADO no SAP (transação ZFI_CONC) e na Coluna K. Se for maior que R$ 0,05, registra a exceção EX-02 e envia ao analista com os dois valores. Sistema: SAP S/4HANA</strong></p></td></tr></tbody></table>

###

# 2.7 - Regras de alçada

<table><tbody><tr><td><p>[22:40]</p></td><td><p><strong>Ação: Pagamentos acima de R$ 250.000,00 não são conciliados pelo robô e seguem para aprovação manual do Coordenador Financeiro. Notas com DDA pendente não são conciliadas até a baixa do título no banco. Sistema: SAP S/4HANA</strong></p></td></tr></tbody></table>

###

# 2.8 - Pagamento em duplicidade

<table><tbody><tr><td><p>[26:15]</p></td><td><p><strong>Ação: Uma mesma NF paga duas vezes gera a exceção EX-03: o fornecedor é bloqueado para novos pagamentos até a análise do Coordenador Financeiro. Sistema: SAP S/4HANA / Portal Banco Atlântico</strong></p></td></tr></tbody></table>

###

# 2.9 - Fornecedor irregular

<table><tbody><tr><td><p>[30:00]</p></td><td><p><strong>Ação: Fornecedor com CNPJ baixado na Receita Federal gera a exceção EX-04: o robô não concilia e notifica o Coordenador Financeiro e o Compliance. Sistema: SAP S/4HANA</strong></p></td></tr></tbody></table>

###

# 2.10 - Arquivamento e relatório

<table><tbody><tr><td><p>[34:20]</p></td><td><p><strong>Ação: Arquiva os comprovantes e envia o Relatório Diário de Conciliação por e-mail até 10h00 (execução da manhã) e 16h00 (execução da tarde). No fechamento contábil (dias 28 a 2), o relatório da manhã deve ser enviado até 9h00. Sistema: E-mail / Servidor de arquivos</strong></p></td></tr></tbody></table>

###

# 2.11 - Volume e frequência

<table><tbody><tr><td><p>[39:50]</p></td><td><p><strong>Ação: Volume médio de 2.400 notas fiscais por mês, com pico de 3.100 notas no fechamento contábil. Hoje dois analistas levam 6 horas por dia, cerca de 4 minutos por nota; o robô leva 35 segundos por nota. Os pagamentos em duplicidade somaram R$ 48.300,00 no primeiro semestre de 2026. A taxa de exceção esperada é de até 8% das notas. Sistema: [A CONFIRMAR]</strong></p></td></tr></tbody></table>

###

# 2.12 - Encerramento

<table><tbody><tr><td><p>[44:30]</p></td><td><p><strong>Ação: Encerra a sessão no SAP e desconecta a VPN. Ficou acordado que o robô não executa pagamentos: ele apenas concilia e aponta exceções. Sistema: SAP S/4HANA / VPN FortiClient</strong></p></td></tr></tbody></table>

# Exceções e Regras de Negócio

Espera-se que o keyuser do processo de negócios e os analistas de negócios documentem abaixo de todas as exceções comerciais identificadas no processo de automação.  
  
**3.1** **Exceções de Negócio**

A tabela abaixo reflete todas as exceções de negócio identificadas durante a avaliação e documentação do processo. Estas são exceções conhecidas e comuns para o processo. Para cada uma dessas exceções, defina uma ação esperada correspondente que o robô deve completar se encontrar a exceção.

<table><tbody><tr><td><p>#</p></td><td><p>Regra / exceção de negócio</p></td><td><p>Ação esperada</p></td><td><p>Situação</p></td></tr><tr><td><p>EX-01</p></td><td><p>NF não encontrada na planilha</p></td><td><p>Mantém em aberto e reprocessa na próxima execução; após 3 execuções sem encontrar, notifica o analista.</p></td><td><p>Validada</p></td></tr><tr><td></td><td></td><td></td><td></td></tr><tr><td><p>EX-02</p></td><td><p>Diferença de valor acima de R$ 0,05</p></td><td><p>Registra a exceção e envia ao analista com os dois valores.</p></td><td><p>Validada</p></td></tr><tr><td></td><td></td><td></td><td></td></tr><tr><td><p>EX-03</p></td><td><p>Pagamento em duplicidade</p></td><td><p>Bloqueia o fornecedor e notifica o Coordenador Financeiro.</p></td><td><p>Validada</p></td></tr><tr><td></td><td></td><td></td><td></td></tr><tr><td><p>EX-04</p></td><td><p>Fornecedor com CNPJ baixado na Receita Federal</p></td><td><p>Não concilia e notifica o Coordenador Financeiro e o Compliance.</p></td><td><p>Incluída na versão 1.1</p></td></tr><tr><td></td><td></td><td></td><td></td></tr><tr><td><p>RN-01</p></td><td><p>Pagamento acima de R$ 250.000,00</p></td><td><p>Não concilia; encaminha para aprovação manual do Coordenador Financeiro.</p></td><td><p>Validada</p></td></tr><tr><td></td><td></td><td></td><td></td></tr></tbody></table>

## 3.2 Exceções de Sistema

-   1.  A tabela abaixo reflete todas as exceções de aplicações encontradas durante a avaliação e documentação do processo. Estas são exceções conhecidas e que já ocorreram antes. Para cada uma dessas exceções, defina uma ação esperada correspondente que o robô deve completar se encontrar a exceção.

<table><tbody><tr><td><p>#</p></td><td><p>Exceção técnica</p></td><td><p>Ação mínima</p></td><td><p>Parâmetros a validar</p></td></tr><tr><td><p>ES-01</p></td><td><p>SAP indisponível</p></td><td><p>Faz 3 novas tentativas, a cada 10 minutos. Persistindo, envia e-mail para a Sustentação RPA BITi9 e encerra.</p></td><td><p>Intervalo de 10 min; 3 tentativas</p></td></tr><tr><td></td><td></td><td></td><td></td></tr><tr><td><p>ES-02</p></td><td><p>VPN desconectada durante a execução</p></td><td><p>Reconecta uma vez. Se falhar, encerra sem gravar status parciais.</p></td><td><p>1 tentativa de reconexão</p></td></tr><tr><td></td><td></td><td></td><td></td></tr><tr><td><p>ES-03</p></td><td><p>Planilha aberta por outro usuário</p></td><td><p>Aguarda 5 minutos e tenta novamente, até 2 vezes. Persistindo, registra a falha no relatório.</p></td><td><p>Intervalo de 5 min; 2 tentativas</p></td></tr><tr><td></td><td></td><td></td><td></td></tr></tbody></table>

## 3.3 Indicadores

-   1.  A tabela abaixo reflete todos os indicadores que são esperados para o processo. Esses indicadores serão utilizados para medir a performance do processo de negócio automatizado.

<table><tbody><tr><td><p><strong><strong>#</strong></strong></p></td><td><p><strong><strong>Indicador</strong></strong></p></td><td><p><strong><strong>Métrica</strong></strong></p></td><td><p><strong><strong>Objetivo</strong></strong></p></td><td><p><strong><strong>Observações</strong></strong></p></td></tr><tr><td><p>1</p></td><td><p>Volume mensal de notas</p></td><td><p>Notas fiscais conciliadas por mês</p></td><td><p>Média de 2.400; pico de 3.100 no fechamento</p></td><td><p>Era 1.800 até a versão 1.1</p></td></tr><tr><td></td></tr><tr><td><p>2</p></td><td><p>Tempo por nota</p></td><td><p>Segundos por nota fiscal</p></td><td><p>Até 35 segundos</p></td><td><p>Processo manual: 4 minutos</p></td></tr><tr><td></td></tr><tr><td><p>3</p></td><td><p>Taxa de exceção</p></td><td><p>% de notas em exceção</p></td><td><p>Até 8%</p></td><td></td></tr><tr><td></td></tr></tbody></table>

## 3.4 Relatórios

-   1.  A tabela abaixo determina todos os relatórios que o processo automatizado deverá gerar.

<table><tbody><tr><td><p><strong><strong>#</strong></strong></p></td><td><p><strong><strong>Nome do Relatório</strong></strong></p></td><td><p><strong><strong>Frequência da Atualização</strong></strong></p></td><td><p><strong><strong>Detalhes</strong></strong></p></td><td><p><strong><strong>Formato/Template do relatório</strong></strong></p></td></tr><tr><td><p>1</p></td><td><p>Relatório Diário de Conciliação</p></td><td><p>2 vezes por dia útil</p></td><td><p>Notas conciliadas e exceções do dia</p></td><td><p>XLSX enviado por e-mail</p></td></tr><tr><td></td></tr></tbody></table>