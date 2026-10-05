import { createRoot } from 'react-dom/client';
import { OverlayApp } from './OverlayApp';
import '@diggy/ui/styles.css';
import './overlay.css';

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(<OverlayApp />);
}
