import { createRoot } from 'react-dom/client';
import { App } from './App';
import '@diggy/ui/styles.css';
import './style.css';

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(<App />);
}
