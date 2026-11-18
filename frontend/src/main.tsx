import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

// No <StrictMode>: in development it runs effects twice, which would send every
// query twice and write duplicate entries to the audit log.
createRoot(document.getElementById('root')!).render(<App />);
