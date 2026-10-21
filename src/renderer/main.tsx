import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { installMuseUnloadBlocker } from './app/editor/unloadBlocker';
import { museRootErrorOptions } from './app/fatalError';
import './styles/global.css';

// 模块级保护先于 React 树建立（M3 T3a；方案 §15.3、§19.2）：根卸载后它们仍然工作。
installMuseUnloadBlocker();

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element.');

createRoot(root, museRootErrorOptions).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
