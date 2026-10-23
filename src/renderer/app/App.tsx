import { DocumentSidebar } from '../components/DocumentSidebar';
import { EditorStatusBar } from '../components/EditorStatusBar';
import { ScoreWorkspace } from '../components/ScoreWorkspace';
import { SourceInspector } from '../components/SourceInspector';
import { Toolbar } from '../components/Toolbar';

export function App() {
  return (
    <div className="app-shell">
      <Toolbar />
      <div className="app-grid">
        <DocumentSidebar />
        <ScoreWorkspace />
        <SourceInspector />
      </div>
      <EditorStatusBar />
    </div>
  );
}
