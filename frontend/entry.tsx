import React from 'react';
import {createRoot} from 'react-dom/client';
import App from '../app/page';
import {ConsoleAuthProvider} from '../components/console-auth';
import '../app/globals.css';

createRoot(document.getElementById('root')!).render(<React.StrictMode><ConsoleAuthProvider><App /></ConsoleAuthProvider></React.StrictMode>);
