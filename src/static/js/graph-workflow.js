// ===== 工作流主件：画布初始化、window 导出与启动（2026-10-24 T397 拆分）=====
// 生成/执行/入口/事件已拆出（stream/generate/run/entry + graph-events），导出块加载期执行、
// 引用族内各件函数（同 graph-continent view 的先例），故主件留尾部。
function initGraphCanvas() {
  graphCanvas = document.getElementById('graphCanvas');
  if (!graphCanvas) return;
  _initGraphCanvasEvents();
  renderGraphCanvas();
}

window.renderGraphCanvas = renderGraphCanvas;

window.sendGraphNewSession = sendGraphNewSession;

window.graphModuleAction = graphModuleAction;

window.quickConnectToHub = quickConnectToHub;

window.buildGraphPathForAnchor = buildGraphPathForAnchor;

window.graphAddOutputPort = graphAddOutputPort;

window.graphRemoveOutputPort = graphRemoveOutputPort;

window.graphAddInputPort = graphAddInputPort;

window.graphRemoveInputPort = graphRemoveInputPort;

window.deleteCustomNode = deleteCustomNode;

window.updateCustomNodeContent = updateCustomNodeContent;


window.handleSourceNodeFile = handleSourceNodeFile;

window.handleSourceNodeDrop = handleSourceNodeDrop;



window.generateRelationNode = generateRelationNode;

window.resetGraphConnections = resetGraphConnections;

window.graphCreateGroup = graphCreateGroup;

window.graphRenameGroup = graphRenameGroup;

window.graphSetGroupColor = graphSetGroupColor;

window.graphAddSelectedToGroup = graphAddSelectedToGroup;

window.graphDeleteGroup = graphDeleteGroup;

window.openAddBlankNodeModal = openAddBlankNodeModal;

window.closeAddBlankNodeModal = closeAddBlankNodeModal;

window.createManualNode = createManualNode;

window.runWorkflowNode = runWorkflowNode;
window.startQuestionWorkflow = startQuestionWorkflow;
window.startSocraticWorkflow = startSocraticWorkflow;
window.runWorkflowNodes = runWorkflowNodes;

window.runAllWorkflowNodes = runAllWorkflowNodes;

window.stopWorkflowRun = stopWorkflowRun;

window.deleteBlankNode = deleteBlankNode;

window.generateBlankNode = generateBlankNode;

window.submitDraftQuestion = submitDraftQuestion;

window.draftSocraticAnswer = draftSocraticAnswer;

window.draftAskAi = draftAskAi;

window.removeDraftNode = removeDraftNode;

window.graphOpenRegenerate = graphOpenRegenerate;
window.generateVizNode = generateVizNode;

window.closeRegeneratePanel = closeRegeneratePanel;

window.submitRegenerateNode = submitRegenerateNode;

window.graphNodeVersionStep = graphNodeVersionStep;

window.graphNodeVersionDelete = graphNodeVersionDelete;

window.zoomGraph = zoomGraph;

window.fitGraph = fitGraph;

window.focusGraphNode = focusGraphNode;

window.focusGraphNodeById = focusGraphNodeById;

window.toggleGraphSearchPanel = toggleGraphSearchPanel;

window.closeGraphSearchPanel = closeGraphSearchPanel;

window.graphSearchInputChanged = graphSearchInputChanged;

window.graphSearchKeydown = graphSearchKeydown;

window.setGraphSearchScope = setGraphSearchScope;

window.focusGraphSearchResult = focusGraphSearchResult;

window.graphToggleTextSelection = graphToggleTextSelection;

window.autoArrangeGraph = autoArrangeGraph;

window.getGraphViewNodes = () => graphView.nodes.map(node => ({ ...node }));

window.getGraphViewEdges = () => graphView.edges.map(edge => ({ ...edge }));

window.getGraphViewDefaultEdges = () => (graphView.defaultEdges || []).map(edge => ({ ...edge }));

window.getSelectedGraphNodeIds = () => Array.from(graphView.selectedNodeIds || []);

window.freeModuleInputPort = _freeModuleInputPort;

window.pushGraphUndo = _pushGraphUndo;

window.applyGraphDiffHighlights = applyGraphDiffHighlights;

window.clearGraphDiffHighlights = clearGraphDiffHighlights;

window.showGraphHarnessPreview = showGraphHarnessPreview;

window.clearGraphHarnessPreview = clearGraphHarnessPreview;

window.getGraphPreviewNodes = () => graphView.previewNodes.map(node => ({ ...node }));

window.toggleGraphView = () => {
  renderGraphCanvas();
};

window.closeGraphView = () => {};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initGraphCanvas);
} else {
  initGraphCanvas();
}
