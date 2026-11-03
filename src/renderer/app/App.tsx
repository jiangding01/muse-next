import { DocumentSidebar } from '../components/DocumentSidebar';
import { EditorStatusBar } from '../components/EditorStatusBar';
import { ReplacementGuardDialog } from '../components/ReplacementGuardDialog';
import { SaveDiagnostics } from '../components/SaveDiagnostics';
import { SaveEntry } from '../components/SaveEntry';
import { ScoreWorkspace } from '../components/ScoreWorkspace';
import { SourceInspector } from '../components/SourceInspector';
import { Toolbar } from '../components/Toolbar';

export function App() {
  return (
    <div className="app-shell">
      <Toolbar />
      <SaveEntry />
      <ReplacementGuardDialog />
      <div className="app-grid">
        <DocumentSidebar />
        <ScoreWorkspace />
        <SourceInspector />
      </div>
      <SaveDiagnostics />
      <EditorStatusBar />
    </div>
  );
}
